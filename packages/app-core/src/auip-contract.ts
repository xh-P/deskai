import { isDeepStrictEqual } from 'node:util';

export const AUIP_SCHEMA = 'amadeus.auip/v0';
export const MAX_MESSAGE_BYTES = 64 * 1024;
export type JsonObject = Record<string, unknown>;
export type Stance = 'spectator' | 'participant';
export type Takeover = 'immediate' | 'safe_point';
export type ControllerStatus = 'idle' | 'active' | 'stopping' | 'blocked';
export type EngagementMode = 'observe' | 'collaborate';

type Precondition = { kind: 'action_available/v1'; statePath: string } |
  { kind: 'grid_cell_empty/v1'; statePath: string; xField: string; yField: string };
type ActionSpec = { description: string; risk: 'none' | 'local_execution'; inputSchema?: JsonObject; preconditions: Precondition[] };
type EventSpec = { beat: boolean; importance: string; terminal: boolean; controllerEffect: boolean; participantOpportunity: boolean };
export interface Manifest {
  schema: typeof AUIP_SCHEMA;
  app: { id: string; title: string; version: string; objective?: string; interactionSummary?: string };
  events: Record<string, EventSpec>;
  actions: Record<string, ActionSpec>;
  stances: Stance[];
  situationKinds: string[];
  controller?: { policyActions: string[]; leaseDurationMs: number; maxActionRateHz: number; takeover: Takeover };
}

const semanticType = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const appId = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const field = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;
const kinds = new Set(['action_availability/v1', 'grid/v1', 'choice/v1', 'scalars/v1', 'sequence/v1', 'controller/v1']);

export function record(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
export function object(value: unknown, code: string): JsonObject {
  const source = record(value);
  if (!source) throw new Error(code);
  return source;
}
export function boundedText(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(code);
  return value.trim();
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_revision');
  return value;
}
export function encodeMessage(value: unknown): string {
  const message = JSON.stringify(value);
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('message_too_large');
  return message;
}

function types(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length > 120 || !semanticType.test(item))) throw new Error(code);
  if (new Set(value).size !== value.length) throw new Error(code);
  return value;
}

function preconditions(value: unknown): Precondition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > 4) throw new Error('invalid_action_preconditions');
  return value.map(item => {
    const source = object(item, 'invalid_action_precondition');
    const statePath = boundedText(source.statePath, 180, 'invalid_state_path');
    const segments = statePath.split('.');
    if (segments.length > 8 || segments.some(part => !field.test(part))) throw new Error('invalid_state_path');
    if (source.kind === 'action_available/v1') return { kind: source.kind, statePath };
    if (source.kind === 'grid_cell_empty/v1' && typeof source.xField === 'string' && field.test(source.xField) &&
        typeof source.yField === 'string' && field.test(source.yField))
      return { kind: source.kind, statePath, xField: source.xField, yField: source.yField };
    throw new Error('unsupported_action_precondition');
  });
}

export function parseManifest(value: unknown): Manifest {
  const source = object(value, 'invalid_manifest');
  encodeMessage(source);
  if (source.schema !== AUIP_SCHEMA) throw new Error('unsupported_schema');
  const app = object(source.app, 'invalid_app');
  const id = boundedText(app.id, 80, 'invalid_app_id');
  if (!appId.test(id)) throw new Error('invalid_app_id');
  const rawEvents = object(source.events, 'invalid_events');
  const rawActions = object(source.actions, 'invalid_actions');
  const eventTypes = types(Object.keys(rawEvents), 'invalid_event_type');
  const actionTypes = types(Object.keys(rawActions), 'invalid_action_type');
  if (!eventTypes.length) throw new Error('missing_events');
  const events = Object.fromEntries(eventTypes.map(name => {
    const event = object(rawEvents[name], 'invalid_event');
    for (const key of ['beat', 'terminal', 'controllerEffect', 'participantOpportunity']) {
      if (event[key] !== undefined && typeof event[key] !== 'boolean') throw new Error('invalid_event_flag');
    }
    const importance = event.importance ?? 'normal';
    if (typeof importance !== 'string' || !['ambient', 'normal', 'important', 'blocking'].includes(importance)) throw new Error('invalid_importance');
    if (event.terminal && event.participantOpportunity) throw new Error('terminal_participant_opportunity');
    return [name, { beat: event.beat === true, terminal: event.terminal === true, importance,
      controllerEffect: event.controllerEffect === true, participantOpportunity: event.participantOpportunity === true }];
  }));
  const actions = Object.fromEntries(actionTypes.map((name): [string, ActionSpec] => {
    const action = object(rawActions[name], 'invalid_action');
    const risk = action.risk ?? 'local_execution';
    if (risk !== 'none' && risk !== 'local_execution') throw new Error('unsupported_action_risk');
    const inputSchema = action.inputSchema === undefined ? undefined : object(action.inputSchema, 'invalid_action_input_schema');
    if (inputSchema && (inputSchema.type !== 'object' || inputSchema.properties !== undefined && !record(inputSchema.properties)))
      throw new Error('invalid_action_input_schema');
    return [name, { description: boundedText(action.description, 240, 'invalid_action_description'), risk,
      inputSchema, preconditions: preconditions(action.preconditions) }];
  }));
  if (!Array.isArray(source.stances) || !source.stances.length || source.stances.some(value => value !== 'spectator' && value !== 'participant'))
    throw new Error('invalid_stance');
  const stances = [...new Set(source.stances)] as Stance[];
  if (!stances.includes('participant') && Object.values(events).some(event => event.participantOpportunity)) throw new Error('participant_stance_required');
  const rawKinds = source.situationKinds ?? [];
  if (!Array.isArray(rawKinds) || rawKinds.some(value => !kinds.has(value))) throw new Error('unsupported_situation_kind');
  const situationKinds = [...new Set(rawKinds)] as string[];
  let controller: Manifest['controller'];
  if (source.controller !== undefined) {
    const spec = object(source.controller, 'invalid_controller');
    const policyActions = types(spec.policyActions, 'invalid_controller_policy_actions');
    if (!policyActions.length || policyActions.some(name => !actions[name]?.inputSchema ||
      actions[name].inputSchema.additionalProperties !== false || !Object.keys(record(actions[name].inputSchema.properties) ?? {}).length))
      throw new Error('invalid_controller_policy_schema');
    if (stances.length !== 2 || !situationKinds.includes('controller/v1')) throw new Error('invalid_controller_stance_or_situation');
    const leaseDurationMs = revision(spec.leaseDurationMs);
    const { maxActionRateHz, takeover } = spec;
    if (leaseDurationMs < 250 || leaseDurationMs > 300_000 || typeof maxActionRateHz !== 'number' || maxActionRateHz <= 0 || maxActionRateHz > 240 ||
        takeover !== 'immediate' && takeover !== 'safe_point') throw new Error('invalid_controller_policy');
    controller = { policyActions, leaseDurationMs, maxActionRateHz, takeover };
  } else if (Object.values(events).some(event => event.controllerEffect)) throw new Error('controller_effect_requires_controller');
  return { schema: AUIP_SCHEMA, app: { id, title: boundedText(app.title, 120, 'invalid_app_title'),
    version: boundedText(app.version ?? '0.1.0', 40, 'invalid_app_version'),
    ...(app.objective ? { objective: boundedText(app.objective, 240, 'invalid_app_objective') } : {}),
    ...(app.interactionSummary ? { interactionSummary: boundedText(app.interactionSummary, 640, 'invalid_interaction_summary') } : {}) },
    events, actions, stances, situationKinds, ...(controller ? { controller } : {}) };
}

function matches(schema: JsonObject, value: unknown, depth = 0): boolean {
  if (depth > 12 || Array.isArray(schema.enum) && !schema.enum.some(item => isDeepStrictEqual(item, value))) return false;
  switch (schema.type) {
    case 'object': {
      const source = record(value);
      if (!source) return false;
      const properties = record(schema.properties) ?? {};
      if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(source, key))) return false;
      return Object.entries(source).every(([key, item]) => {
        if (!Object.hasOwn(properties, key)) return schema.additionalProperties !== false;
        const child = record(properties[key]);
        return child ? matches(child, item, depth + 1) : properties[key] === true;
      });
    }
    case 'array': {
      const items = record(schema.items);
      return Array.isArray(value) && (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems) &&
        (!items || value.every(item => matches(items, item, depth + 1)));
    }
    case 'string': return typeof value === 'string' && (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength) &&
      (typeof schema.minLength !== 'number' || value.length >= schema.minLength);
    case 'number': case 'integer': return typeof value === 'number' && Number.isFinite(value) &&
      (schema.type !== 'integer' || Number.isInteger(value)) && (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
      (typeof schema.maximum !== 'number' || value <= schema.maximum);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return schema.type === undefined;
  }
}

type AvailableChoice = { action: string; payload: JsonObject };
type Availability = { family: string[]; available: string[] };
export interface StateContract {
  state: JsonObject;
  choiceFamily: Set<string>;
  choices: AvailableChoice[];
  availability: Map<string, Availability>;
}

export function readState(value: unknown, manifest: Manifest, previous?: StateContract): StateContract {
  const state = object(value, 'invalid_state');
  const choiceFamily = new Set<string>();
  const choices: AvailableChoice[] = [];
  const availability = new Map<string, Availability>();
  const present = new Set<string>();
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 24) throw new Error('state_too_deep');
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}.${index}`, depth + 1)); return; }
    const node = record(value);
    if (!node) return;
    if (typeof node.kind === 'string') present.add(node.kind);
    if (node.kind === 'choice/v1') {
      const defaultAction = typeof node.action === 'string' ? node.action : '';
      for (const name of types(node.actionTypes ?? [], 'invalid_choice_family')) choiceFamily.add(name);
      if (defaultAction) choiceFamily.add(defaultAction);
      if (!Array.isArray(node.options)) throw new Error('invalid_choice_options');
      for (const item of node.options) {
        const option = object(item, 'invalid_choice_option');
        const action = typeof option.action === 'string' ? option.action : defaultAction;
        if (!action) continue;
        choiceFamily.add(action);
        const payload = object(option.payload, 'invalid_choice_payload');
        if (option.available === true || defaultAction && option.available === undefined) choices.push({ action, payload });
      }
    }
    if (node.kind === 'action_availability/v1') {
      const family = types(node.actionTypes, 'invalid_action_availability');
      const available = types(node.availableActionTypes, 'invalid_action_availability');
      if (!family.length || available.some(name => !family.includes(name))) throw new Error('invalid_action_availability');
      availability.set(path, { family, available });
    }
    for (const [key, item] of Object.entries(node)) visit(item, path ? `${path}.${key}` : key, depth + 1);
  };
  visit(state, '', 0);
  if (manifest.situationKinds.some(kind => !present.has(kind))) throw new Error('missing_declared_situation');
  if ([...choiceFamily].some(name => !Object.hasOwn(manifest.actions, name))) throw new Error('choice_action_undeclared');
  if (previous && !isDeepStrictEqual(choiceFamily, previous.choiceFamily)) throw new Error('choice_action_family_changed');
  for (const [path, { family }] of availability) {
    if (family.some(name => !manifest.actions[name]?.preconditions.some(condition => condition.kind === 'action_available/v1' && condition.statePath === path)))
      throw new Error('action_availability_precondition_missing');
  }
  for (const [name, action] of Object.entries(manifest.actions)) {
    if (action.preconditions.some(condition => condition.kind === 'action_available/v1' && !availability.get(condition.statePath)?.family.includes(name)))
      throw new Error('action_availability_surface_missing');
  }
  return { state, choiceFamily, choices, availability };
}

export function checkAction(manifest: Manifest, current: StateContract, name: string, value: unknown): JsonObject {
  const action = Object.hasOwn(manifest.actions, name) && manifest.actions[name];
  if (!action) throw new Error('undeclared_action');
  const payload = object(value, 'invalid_action_payload');
  if (action.inputSchema && !matches(action.inputSchema, payload)) throw new Error('invalid_action_payload');
  if (current.choiceFamily.has(name) && !current.choices.some(option => option.action === name && isDeepStrictEqual(option.payload, payload)))
    throw new Error('action_not_available');
  for (const condition of action.preconditions) {
    if (condition.kind === 'action_available/v1') {
      if (!current.availability.get(condition.statePath)?.available.includes(name)) throw new Error('action_precondition_failed');
      continue;
    }
    let node: unknown = current.state;
    for (const segment of condition.statePath.split('.')) {
      const source = record(node);
      node = source && Object.hasOwn(source, segment) ? source[segment] : undefined;
    }
    const grid = record(node);
    const x = payload[condition.xField]; const y = payload[condition.yField];
    if (grid?.kind !== 'grid/v1' || !Array.isArray(grid.rows) || typeof grid.empty !== 'string' || Array.from(grid.empty).length !== 1 ||
        !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.rows.length !== grid.height ||
        grid.rows.some(row => typeof row !== 'string' || Array.from(row).length !== grid.width)) throw new Error('action_precondition_unverifiable');
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 ||
        x >= Number(grid.width) || y >= Number(grid.height) || Array.from(grid.rows[y] as string)[x] !== grid.empty) throw new Error('action_precondition_failed');
  }
  return payload;
}
