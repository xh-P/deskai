import { BrowserWindow, Menu, screen, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { PET_VARIANTS, type PetGeometry, type PetPreferences, type PetPreferencePatch, type PetSnapshot } from '../../../packages/desktop-pet/src/types.ts';
import { clampPetBounds, clampPetDragBounds, PetDrag, resizePetKeepingFeet } from '../../../packages/desktop-pet/src/drag.ts';
import { defaultPetPreferences, loadPetPreferences, mergePetPreferences, savePetPreferences } from './pet-settings.ts';

const petPage = 'deskai://app/index.html?pet=1';
const names: Record<(typeof PET_VARIANTS)[number], string> = {
  'uniform-chibi': '校服 · Q 版', 'uniform-normal': '校服 · 原作比例',
  'witch-chibi': '魔法服 · Q 版', 'witch-normal': '魔法服 · 原作比例',
};

function overlap(a: Electron.Rectangle, b: Electron.Rectangle): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

function selectedWorkArea(bounds: Electron.Rectangle): Electron.Rectangle | undefined {
  let best: Electron.Rectangle | undefined;
  let amount = 0;
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea;
    const shared = overlap(bounds, area);
    if (shared > amount) { best = area; amount = shared; }
  }
  return best;
}

function clampToArea(bounds: Electron.Rectangle, area: Electron.Rectangle): Electron.Rectangle {
  return clampPetBounds(bounds, area);
}

export class PetWindowManager {
  private window?: BrowserWindow;
  private preferences: PetPreferences = { ...defaultPetPreferences };
  private snapshot: PetSnapshot;
  private geometry = new Map<string, number>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saving: Promise<unknown> = Promise.resolve();
  private opaqueHit = false;
  private readonly dragState = new PetDrag();
  private started = false;
  private preferencesLoaded = false;
  private quitting = false;

  constructor(private readonly userData: string, private readonly callbacks: {
    showMain: () => void; stopReply: () => void; changed: (snapshot: PetSnapshot) => void;
  }, private readonly persist = true) {
    this.snapshot = this.makeSnapshot('off', '', null, 0);
  }

  private makeSnapshot(state: PetSnapshot['state'], subtitle: string, sessionId: string | null, generationId: number): PetSnapshot {
    return { variant: this.preferences.variant, size: this.preferences.size, visible: this.preferences.visible,
      alwaysOnTop: this.preferences.alwaysOnTop, motionMode: this.preferences.motionMode,
      state, subtitle, sessionId, generationId };
  }

  private dimensions(): { width: number; height: number } {
    const aspect = this.geometry.get(this.preferences.variant) ?? 0.8;
    return { width: Math.max(230, Math.round(this.preferences.size * aspect + 48)), height: this.preferences.size + 88 };
  }

  private defaultBounds(): Electron.Rectangle {
    const { width, height } = this.dimensions();
    const area = screen.getPrimaryDisplay().workArea;
    return clampToArea({ x: area.x + area.width - width - 96, y: area.y + area.height - height - 20,
      width, height }, area);
  }

  async start(show = true): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.preferencesLoaded) {
      try { if (this.persist) this.preferences = await loadPetPreferences(this.userData); }
      catch (error) { this.started = false; throw error; }
      this.preferencesLoaded = true;
    }
    this.snapshot = this.makeSnapshot(this.snapshot.state, this.snapshot.subtitle, this.snapshot.sessionId, this.snapshot.generationId);
    const dimensions = this.dimensions();
    const candidate = this.preferences.position
      ? { ...this.preferences.position, ...dimensions } : this.defaultBounds();
    const area = selectedWorkArea(candidate);
    const bounds = area ? clampPetDragBounds(candidate, area) : this.defaultBounds();
    this.preferences.position = { x: bounds.x, y: bounds.y };
    const pet = new BrowserWindow({ ...bounds, transparent: true, frame: false, hasShadow: false,
      resizable: false, skipTaskbar: true, show: false, alwaysOnTop: this.preferences.alwaysOnTop,
      backgroundColor: '#00000000', autoHideMenuBar: true,
      webPreferences: { preload: path.join(import.meta.dirname, 'pet-preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    this.window = pet;
    if (this.preferences.alwaysOnTop) pet.setAlwaysOnTop(true, 'floating');
    pet.setIgnoreMouseEvents(true, { forward: true });
    pet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    pet.webContents.on('will-navigate', (event, destination) => { if (destination !== petPage) event.preventDefault(); });
    pet.on('move', () => this.rememberPosition());
    pet.on('blur', () => this.cancelDrag());
    pet.on('hide', () => this.cancelDrag());
    pet.webContents.on('render-process-gone', () => this.cancelDrag());
    pet.on('closed', () => {
      if (this.window !== pet) return;
      this.window = undefined;
      this.started = false;
      this.opaqueHit = false;
      this.dragState.cancel();
      if (!this.quitting) {
        this.preferences.visible = false;
        this.snapshot = this.makeSnapshot(this.snapshot.state, this.snapshot.subtitle, this.snapshot.sessionId, this.snapshot.generationId);
        this.publish();
        this.scheduleSave();
      }
    });
    try { await pet.loadURL(petPage); }
    catch (error) { if (!pet.isDestroyed()) pet.destroy(); throw error; }
    if (show && this.preferences.visible) pet.showInactive();
    this.publish();
  }

  owns(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents &&
      event.senderFrame?.url === petPage;
  }

  getSnapshot(): PetSnapshot { return { ...this.snapshot }; }
  getWindow(): BrowserWindow | undefined { return this.window && !this.window.isDestroyed() ? this.window : undefined; }
  showIfVisible(): void { if (this.preferences.visible) this.getWindow()?.showInactive(); }
  getPreferences(): PetPreferences { return { ...this.preferences, position: this.preferences.position && { ...this.preferences.position } }; }
  prepareToQuit(): void { this.quitting = true; }

  setActivity(activity: Pick<PetSnapshot, 'state' | 'subtitle' | 'sessionId' | 'generationId'>): void {
    const next = this.makeSnapshot(activity.state, activity.subtitle, activity.sessionId, activity.generationId);
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    this.publish();
  }

  update(value: unknown): PetSnapshot {
    const next = mergePetPreferences(this.preferences, value);
    const before = this.preferences;
    if (JSON.stringify(next) === JSON.stringify(before)) return this.getSnapshot();
    this.preferences = next;
    if (next.variant !== before.variant || next.size !== before.size) {
      this.cancelDrag();
      this.setOpaqueHit(false);
      this.resizeKeepingFeet();
    }
    if (next.alwaysOnTop !== before.alwaysOnTop && this.window && !this.window.isDestroyed()) {
      this.window.setAlwaysOnTop(next.alwaysOnTop, next.alwaysOnTop ? 'floating' : 'normal');
    }
    if (next.visible !== before.visible) {
      const pet = this.getWindow();
      if (next.visible) {
        if (pet) pet.showInactive();
        else void this.start().catch(error => { console.error('Pet window reopen failed:', error); });
      } else if (pet) { pet.hide(); this.setOpaqueHit(false); }
    }
    this.snapshot = this.makeSnapshot(this.snapshot.state, this.snapshot.subtitle, this.snapshot.sessionId, this.snapshot.generationId);
    this.publish();
    this.scheduleSave();
    return this.getSnapshot();
  }

  reportGeometry(value: PetGeometry): void {
    if (!value || !PET_VARIANTS.includes(value.variant) || !Number.isFinite(value.aspect) ||
        value.aspect < 0.2 || value.aspect > 3) return;
    const previous = this.geometry.get(value.variant);
    if (previous !== undefined && Math.abs(previous - value.aspect) < 0.001) return;
    this.geometry.set(value.variant, value.aspect);
    if (value.variant === this.preferences.variant) {
      this.cancelDrag();
      this.setOpaqueHit(false);
      this.resizeKeepingFeet(true);
    }
  }

  private resizeKeepingFeet(keepManualTop = false): void {
    const pet = this.window;
    if (!pet || pet.isDestroyed()) return;
    const prior = pet.getBounds();
    const next = this.dimensions();
    const area = selectedWorkArea(prior) ?? screen.getPrimaryDisplay().workArea;
    pet.setBounds(resizePetKeepingFeet(prior, next, area, keepManualTop));
    this.rememberPosition();
  }

  ensureVisible(): void {
    const pet = this.window;
    if (!pet || pet.isDestroyed()) return;
    const bounds = pet.getBounds();
    const area = selectedWorkArea(bounds);
    pet.setBounds(area ? clampToArea(bounds, area) : this.defaultBounds());
    this.rememberPosition();
  }

  setOpaqueHit(opaque: boolean): void {
    const pet = this.window;
    if (this.opaqueHit === opaque) return;
    this.opaqueHit = opaque;
    if (pet && !pet.isDestroyed() && !this.dragState.active) pet.setIgnoreMouseEvents(!opaque, { forward: true });
  }

  private cancelDrag(): void {
    if (!this.dragState.cancel()) return;
    const pet = this.getWindow();
    if (pet) pet.setIgnoreMouseEvents(!this.opaqueHit, { forward: true });
    this.rememberPosition();
  }

  drag(phase: 'start' | 'move' | 'end', pointerId: number): void {
    const pet = this.window;
    if (!pet || pet.isDestroyed()) return;
    if (phase === 'start') {
      if (!this.opaqueHit) return;
      const point = screen.getCursorScreenPoint(), bounds = pet.getBounds();
      if (!this.dragState.begin(pointerId, point, bounds)) return;
      pet.setIgnoreMouseEvents(false);
    } else if (phase === 'move') {
      const point = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(point).workArea;
      const bounds = this.dragState.move(pointerId, point, area);
      if (bounds) {
        const current = pet.getBounds();
        if (bounds.x !== current.x || bounds.y !== current.y ||
            bounds.width !== current.width || bounds.height !== current.height) pet.setBounds(bounds);
      }
    } else if (phase === 'end' && this.dragState.end(pointerId)) {
      pet.setIgnoreMouseEvents(!this.opaqueHit, { forward: true });
      this.rememberPosition();
    }
  }

  showContextMenu(): void {
    if (!this.window || this.window.isDestroyed()) return;
    Menu.buildFromTemplate(this.menuTemplate()).popup({ window: this.window });
  }

  menuTemplate(): MenuItemConstructorOptions[] {
    const variantItems: MenuItemConstructorOptions[] = PET_VARIANTS.map(variant => ({
      label: names[variant], type: 'radio', checked: this.preferences.variant === variant,
      click: () => { this.update({ variant }); },
    }));
    const sizeItems: MenuItemConstructorOptions[] = [120, 180, 220, 280, 360].map(size => ({
      label: `${size} px`, type: 'radio', checked: this.preferences.size === size,
      click: () => { this.update({ size }); },
    }));
    return [
      { label: '显示桌宠', type: 'checkbox', checked: this.preferences.visible,
        click: () => { this.update({ visible: !this.preferences.visible }); } },
      { label: '造型', submenu: variantItems },
      { label: '尺寸', submenu: sizeItems },
      { label: '保持置顶', type: 'checkbox', checked: this.preferences.alwaysOnTop,
        click: () => { this.update({ alwaysOnTop: !this.preferences.alwaysOnTop }); } },
      { label: '桌宠动画', submenu: [
        { label: '轻微动画', type: 'radio', checked: this.preferences.motionMode === 'gentle',
          click: () => { this.update({ motionMode: 'gentle' }); } },
        { label: '跟随系统', type: 'radio', checked: this.preferences.motionMode === 'system',
          click: () => { this.update({ motionMode: 'system' }); } },
      ] },
      { type: 'separator' },
      { label: '打开主窗口', click: this.callbacks.showMain },
      { label: '停止当前回复', enabled: Boolean(this.snapshot.sessionId), click: this.callbacks.stopReply },
    ];
  }

  private rememberPosition(): void {
    const pet = this.window;
    if (!pet || pet.isDestroyed()) return;
    const { x, y } = pet.getBounds();
    if (this.preferences.position?.x === x && this.preferences.position.y === y) return;
    this.preferences.position = { x, y };
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.persist) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const copy = this.getPreferences();
      this.saving = this.saving.then(() => savePetPreferences(this.userData, copy)).catch(() => {});
    }, 350);
  }

  async flush(): Promise<void> {
    if (!this.persist) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    const copy = this.getPreferences();
    await this.saving.catch(() => {});
    await savePetPreferences(this.userData, copy);
  }

  private publish(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('pet:snapshot', this.getSnapshot());
    this.callbacks.changed(this.getSnapshot());
  }
}

export { petPage };
