export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Position {
  x: number;
  y: number;
}

export interface Player {
  id: string;
  displayName: string;
  position: Position;
  hp: number;
  connectedAt: string;
  order: number;
}

export interface SceneOption {
  text: string;
  goto: string;
  conditions?: ScriptCondition[];
  flags?: FlagAction;
}

export type ScriptConditionOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'has';

export interface ScriptCondition {
  key: string;
  operator: ScriptConditionOperator;
  value: unknown;
}

export interface ScriptEffect {
  type: 'set' | 'modify' | 'add_item' | 'remove_item';
  key?: string;
  value?: unknown;
}

export interface FlagAction {
  requires?: string[];
  sets?: string[];
  clears?: string[];
}

export interface ScriptInventory {
  add?: string[];
  remove?: string[];
  require?: string[];
}

export type EncounterRole = 'enemy' | 'ally' | 'neutral';

export interface EncounterParticipant {
  id: string;
  role: EncounterRole;
  hp?: number;
  ac?: number;
}

export interface EncounterDialogueLine {
  speaker: string;
  text: string;
}

export interface EncounterOutcomes {
  win?: string;
  lose?: string;
  flee?: string;
}

export type EncounterType = 'npc' | 'combat' | 'event';

export interface Encounter {
  type: EncounterType;
  participants?: EncounterParticipant[];
  dialogue?: EncounterDialogueLine[];
  loot?: string[];
  outcomes?: EncounterOutcomes;
}

export interface ScriptRoll {
  count: number;
  type: string;
}

export interface ScriptScene {
  id: string;
  text: string;
  options?: SceneOption[];
  dice?: boolean;
  roll?: ScriptRoll;
  success?: string;
  fail?: string;
  moving?: boolean;
  goto?: string;
  encounter?: Encounter;
  conditions?: ScriptCondition[];
  effects?: ScriptEffect[];
  inventory?: ScriptInventory;
  flags?: FlagAction;
}

export interface Script {
  scenes: ScriptScene[];
  flags?: Record<string, boolean>;
}

export interface RollState {
  count: number;
  type: string;
  sides: number;
}

export interface PlayerSceneState {
  sceneId: string | null;
  sceneText: string;
  availableOptions: SceneOption[];
  diceRollRequired: boolean;
  rollState: RollState | null;
}

export interface GameMap {
  width: number;
  height: number;
  totalPlayers: number;
}

export interface GameState {
  players: Record<string, Player>;
  map: GameMap;
  log: string[];
  masterId: string | null;
  gameStarted: boolean;
  turnOrder: string[];
  currentTurnId: string | null;
  nextTurnId: string | null;
  scriptLoaded: boolean;
  scriptName: string | null;
  playerScenes: Record<string, PlayerSceneState>;
  playerInventory: Record<string, string[]>;
  globalFlags: Record<string, boolean>;
}

export const gameState: GameState = {
  players: {} as Record<string, Player>,
  map: {
    width: 20,
    height: 20,
    totalPlayers: 0,
  },
  log: [] as string[],
  masterId: null,
  gameStarted: false,
  turnOrder: [],
  currentTurnId: null,
  nextTurnId: null,
  scriptLoaded: false,
  scriptName: null,
  playerScenes: {},
  playerInventory: {},
  globalFlags: {},
};

export interface ClientJoinMessage {
  type: 'join';
  payload: {
    displayName: string;
  };
}

export interface ClientClaimMasterMessage {
  type: 'claimMaster';
}

export interface ClientStartGameMessage {
  type: 'startGame';
}

export interface ClientRollDiceMessage {
  type: 'rollDice';
  payload: {
    sides?: number;
    quantity?: number;
  };
}

export interface ClientMoveMessage {
  type: 'move';
  payload: {
    direction: Direction;
  };
}

export interface ClientScriptActionMessage {
  type: 'scriptAction';
  payload: {
    scriptId: string;
    step: number;
  };
}

export interface ClientChooseOptionMessage {
  type: 'chooseOption';
  payload: {
    optionIndex: number;
  };
}

export type ClientMessage =
  | ClientJoinMessage
  | ClientClaimMasterMessage
  | ClientStartGameMessage
  | ClientRollDiceMessage
  | ClientMoveMessage
  | ClientScriptActionMessage
  | ClientChooseOptionMessage;

export interface ServerIdMessage {
  type: 'id';
  payload: {
    playerId: string;
  };
}

export interface ServerStateMessage {
  type: 'state';
  payload: GameState;
}

export interface ServerDiceMessage {
  type: 'diceResult';
  payload: {
    playerId: string;
    sides: number;
    quantity: number;
    total: number;
    rolls: number[];
  };
}

export interface ServerScriptMessage {
  type: 'scriptUpdate';
  payload: {
    playerId: string;
    scriptId: string;
    step: number;
    message: string;
  };
}

export interface ServerSceneMessage {
  type: 'sceneUpdate';
  payload: {
    playerId: string;
    sceneId: string | null;
    text: string;
    options: SceneOption[];
    diceRollRequired: boolean;
  };
}

export interface ServerErrorMessage {
  type: 'error';
  payload: {
    message: string;
  };
}

export type ServerMessage =
  | ServerIdMessage
  | ServerStateMessage
  | ServerDiceMessage
  | ServerScriptMessage
  | ServerErrorMessage
  | ServerSceneMessage;
