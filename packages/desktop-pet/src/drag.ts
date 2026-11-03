export type PetPoint = { x: number; y: number };
export type PetRect = PetPoint & { width: number; height: number };

export function clampPetBounds(bounds: PetRect, area: PetRect): PetRect {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width, height,
  };
}

export function clampPetDragBounds(bounds: PetRect, area: PetRect): PetRect {
  const whole = clampPetBounds(bounds, area);
  // The figure sits at the bottom of the transparent window. Keep its feet
  // visible and reachable, while allowing a low grab point to reach the top.
  const visibleFoot = Math.min(64, whole.height);
  return {
    ...whole,
    y: Math.min(Math.max(bounds.y, area.y - whole.height + visibleFoot),
      area.y + area.height - whole.height),
  };
}

export function resizePetKeepingFeet(prior: PetRect, size: { width: number; height: number },
  area: PetRect, keepManualTop = false): PetRect {
  const candidate = {
    x: Math.round(prior.x + (prior.width - size.width) / 2),
    y: prior.y + prior.height - size.height,
    ...size,
  };
  return keepManualTop && prior.y < area.y
    ? clampPetDragBounds(candidate, area) : clampPetBounds(candidate, area);
}

export class PetDrag {
  private origin?: { pointerId: number; cursor: PetPoint; bounds: PetRect };

  get active(): boolean { return this.origin !== undefined; }

  begin(pointerId: number, cursor: PetPoint, bounds: PetRect): boolean {
    if (this.origin) return false;
    this.origin = { pointerId, cursor: { ...cursor }, bounds: { ...bounds } };
    return true;
  }

  move(pointerId: number, cursor: PetPoint, area: PetRect): PetRect | undefined {
    const origin = this.origin;
    if (!origin || origin.pointerId !== pointerId) return undefined;
    // The cursor and window use DIP coordinates. Project from the last valid
    // anchor, never from a delayed native move event.
    const projected = {
      ...origin.bounds,
      x: Math.round(origin.bounds.x + cursor.x - origin.cursor.x),
      y: Math.round(origin.bounds.y + cursor.y - origin.cursor.y),
    };
    const bounded = clampPetDragBounds(projected, area);
    // At a boundary, discard only the excess motion on that axis. The first
    // reverse pixel then moves the pet instead of crossing an invisible gap.
    if (bounded.x !== projected.x) {
      origin.bounds.x = bounded.x;
      origin.cursor.x = cursor.x;
    }
    if (bounded.y !== projected.y) {
      origin.bounds.y = bounded.y;
      origin.cursor.y = cursor.y;
    }
    return bounded;
  }

  end(pointerId: number): boolean {
    if (this.origin?.pointerId !== pointerId) return false;
    this.origin = undefined;
    return true;
  }

  cancel(): boolean {
    if (!this.origin) return false;
    this.origin = undefined;
    return true;
  }
}
