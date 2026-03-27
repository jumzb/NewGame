import {
  gameState,
  GameState,
  Player,
  Position,
  Direction,
  SceneOption,
  Script,
  ScriptScene,
  RollState,
  PlayerSceneState,
  FlagAction,
} from '../../shared/types';
import { rollDice, DiceResult } from './Dice';
import Ajv, { JSONSchemaType } from 'ajv';
import addMetaSchema2020 from 'ajv/dist/refs/json-schema-2020-12/index.js';
import scriptSchema from '../../shared/scriptSchema.json';

interface ScriptProgress {
  scriptId: string;
  step: number;
  message: string;
}

interface OptionResult {
  scene: ScriptScene;
  flagsUpdated: boolean;
}

const ajv = new Ajv({ strict: false });
addMetaSchema2020.call(ajv, false);
const validateScript = ajv.compile<Script>(
  scriptSchema as unknown as JSONSchemaType<Script>
);

export class Game {
  private state: GameState;
  private nextOrder = 1;
  private currentTurnIndex = 0;
  private scriptProgress: Record<string, number> = {};
  private script: Script | null = null;

  constructor(initialState: GameState = gameState) {
    this.state = initialState;
  }

  getState(): GameState {
    return this.state;
  }

  private setPlayerConnected(id: string, connected: boolean) {
    const player = this.state.players[id];
    if (!player) return;
    if (player.connected === connected) return;
    player.connected = connected;
    if (connected) {
      player.connectedAt = new Date().toISOString();
    }
    const verb = connected ? 'reconnected' : 'disconnected';
    this.log(`${player.displayName} ${verb}.`, id);
  }

  reconnectPlayer(id: string): boolean {
    if (!this.state.players[id]) return false;
    this.setPlayerConnected(id, true);
    return true;
  }

  disconnectPlayer(id: string) {
    this.setPlayerConnected(id, false);
  }

  private checkFlagRequirements(action?: FlagAction): boolean {
    if (!action?.requires?.length) return true;
    return action.requires.every((flag) => this.state.globalFlags[flag] !== false);
  }

  private applyFlagAction(action?: FlagAction): boolean {
    if (!action) return false;
    let changed = false;
    action.sets?.forEach((flag) => {
      if (this.state.globalFlags[flag] !== true) {
        this.state.globalFlags[flag] = true;
        changed = true;
      }
    });
    action.clears?.forEach((flag) => {
      if (this.state.globalFlags[flag] !== false) {
        this.state.globalFlags[flag] = false;
        changed = true;
      }
    });
    return changed;
  }

  hasPlayer(id: string): boolean {
    return Boolean(this.state.players[id]);
  }

  addPlayer(id: string, displayName: string): Player {
    const player: Player = {
      id,
      displayName,
      position: { x: 0, y: 0 },
      hp: 10,
      connectedAt: new Date().toISOString(),
      connected: true,
      order: this.nextOrder++,
    };
    this.state.players[id] = player;
    this.ensurePlayerInventory(id);
    this.state.map.totalPlayers = Object.keys(this.state.players).length;
    this.ensureTurnOrder();
    this.ensurePlayerSceneState(id);
    this.log(`${displayName} joined the table.`, id);
    return player;
  }

  removePlayer(id: string) {
    const player = this.state.players[id];
    if (!player) return;
    delete this.state.players[id];
    delete this.state.playerScenes[id];
    delete this.state.playerInventory[id];
    this.state.map.totalPlayers = Object.keys(this.state.players).length;
    this.ensureTurnOrder();
    this.log(`${player.displayName} disconnected.`, id);
    if (this.state.masterId === id) {
      this.state.masterId = null;
      this.log(`Master slot freed because ${player.displayName} left.`);
    }
    if (this.state.gameStarted && this.state.currentTurnId === id) {
      this.advanceTurn();
    }
  }

  movePlayer(id: string, direction: Direction) {
    if (!this.state.gameStarted || this.state.currentTurnId !== id) return;
    const player = this.state.players[id];
    if (!player) return;
    player.position = this.calculateNextPosition(player.position, direction);
    this.log(
      `${player.displayName} moved ${direction} to (${player.position.x}, ${player.position.y}).`,
      id
    );
  }

  rollForPlayer(id: string): DiceResult | null {
    if (!this.state.gameStarted || this.state.currentTurnId !== id) {
      return null;
    }
    const player = this.state.players[id];
    const playerScene = this.ensurePlayerSceneState(id);
    const rollSpec = playerScene?.rollState;
    if (!playerScene?.diceRollRequired || !rollSpec) return null;
    if (!player || !rollSpec) return null;
    const result = rollDice(rollSpec.sides, rollSpec.count);
    const message = `${player.displayName} rolled ${result.total} (${result.rolls.join(', ')}) on ${result.quantity}d${result.sides}.`;
    this.log(message, id);
    this.advanceTurn();
    return result;
  }

  runScriptAction(id: string, scriptId: string, step: number): ScriptProgress | null {
    if (!this.state.gameStarted || this.state.currentTurnId !== id) return null;
    const player = this.state.players[id];
    if (!player) return null;
    this.scriptProgress[scriptId] = step;
    const message = `${player.displayName} advanced script ${scriptId} to step ${step}.`;
    this.log(message, id);
    return { scriptId, step, message };
  }

  claimMaster(id: string): boolean {
    if (!this.hasPlayer(id)) return false;
    if (this.state.masterId && this.state.masterId !== id) return false;
    if (this.state.masterId === id) return true;
    this.state.masterId = id;
    this.log(`${this.state.players[id].displayName} claimed the master seat.`, id);
    return true;
  }

  startGame(): boolean {
    if (this.state.gameStarted) return false;
    if (!this.state.scriptLoaded) return false;
    if (!this.state.masterId || !this.state.players[this.state.masterId]) return false;
    if (!this.state.turnOrder.length) return false;
    this.state.gameStarted = true;
    this.currentTurnIndex = 0;
    this.state.currentTurnId = this.state.turnOrder[this.currentTurnIndex];
    this.state.nextTurnId =
      this.state.turnOrder[(this.currentTurnIndex + 1) % this.state.turnOrder.length] ?? null;
    const initialScene = this.script?.scenes.length ? this.script.scenes[0] : null;
    Object.keys(this.state.players).forEach((playerId) => {
      this.state.playerInventory[playerId] = [];
      this.state.playerScenes[playerId] = this.buildPlayerSceneState(initialScene, playerId, true);
    });
    const masterName = this.state.players[this.state.masterId].displayName;
    this.log(`${masterName} started the game.`, this.state.masterId ?? undefined);
    return true;
  }

  loadScript(script: Script, filename?: string) {
    if (!validateScript(script)) {
      const errors = validateScript.errors
        ? validateScript.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
        : 'schema validation failed';
      throw new Error(`Script validation error: ${errors}`);
    }
    this.script = script;
    this.state.globalFlags = { ...(script.flags ?? {}) };
    const initialScene = script.scenes.length ? script.scenes[0] : null;
    Object.keys(this.state.players).forEach((playerId) => {
      this.state.playerInventory[playerId] = [];
      this.state.playerScenes[playerId] = this.buildPlayerSceneState(initialScene, playerId, false);
    });
    this.state.scriptLoaded = true;
    this.state.scriptName = filename ?? null;
    const sceneId = initialScene?.id;
    this.log(`Script loaded${sceneId ? `; starting scene ${sceneId}` : ''}`, this.state.masterId ?? undefined);
  }

  chooseOption(playerId: string, optionIndex: number): OptionResult | null {
    if (!this.script || !this.state.gameStarted) return null;
    if (this.state.currentTurnId !== playerId) return null;
    const playerScene = this.ensurePlayerSceneState(playerId);
    if (!playerScene?.availableOptions.length) return null;
    const option = playerScene.availableOptions[optionIndex];
    if (!option) return null;
    const nextScene = this.getSceneById(option.goto);
    if (!nextScene) return null;
    const optionFlagsChanged = this.applyFlagAction(option.flags);
    const sceneFlagsChanged = this.applyFlagAction(nextScene.flags);
    const newSceneState = this.buildPlayerSceneState(nextScene, playerId, true);
    this.state.playerScenes[playerId] = newSceneState;
    const playerName = this.state.players[playerId]?.displayName ?? 'Unknown';
    this.log(`${playerName} chose "${option.text}"`, playerId);
    if (!newSceneState.diceRollRequired) {
      this.advanceTurn();
    }
    return { scene: nextScene, flagsUpdated: optionFlagsChanged || sceneFlagsChanged };
  }

  private ensureTurnOrder() {
    const ordered = Object.values(this.state.players).sort((a, b) => a.order - b.order);
    this.state.turnOrder = ordered.map((player) => player.id);
    if (!this.state.gameStarted || !this.state.turnOrder.length) {
      this.state.currentTurnId = null;
      this.state.nextTurnId = null;
      return;
    }
    if (!this.state.turnOrder.includes(this.state.currentTurnId ?? '')) {
      this.currentTurnIndex = 0;
    } else {
      this.currentTurnIndex = this.state.turnOrder.indexOf(this.state.currentTurnId ?? '');
    }
    this.state.currentTurnId = this.state.turnOrder[this.currentTurnIndex];
    this.state.nextTurnId =
      this.state.turnOrder[(this.currentTurnIndex + 1) % this.state.turnOrder.length] ?? null;
  }

  private advanceTurn() {
    if (!this.state.turnOrder.length) {
      this.state.currentTurnId = null;
      this.state.nextTurnId = null;
      return;
    }
    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.state.turnOrder.length;
    this.state.currentTurnId = this.state.turnOrder[this.currentTurnIndex];
    this.state.nextTurnId =
      this.state.turnOrder[(this.currentTurnIndex + 1) % this.state.turnOrder.length] ?? null;
    const player = this.state.players[this.state.currentTurnId];
    if (player) {
      this.log(`${player.displayName} is now up for the roll.`, player.id);
    }
  }

  private getSceneById(id: string): ScriptScene | undefined {
    return this.script?.scenes.find((scene) => scene.id === id);
  }

  getPlayerSceneState(playerId: string): PlayerSceneState | null {
    return this.state.playerScenes[playerId] ?? null;
  }

  private ensurePlayerInventory(playerId: string): string[] {
    if (!this.state.playerInventory[playerId]) {
      this.state.playerInventory[playerId] = [];
    }
    return this.state.playerInventory[playerId];
  }

  private applySceneInventory(playerId: string, scene: ScriptScene | null) {
    if (!scene?.inventory) return;
    const inventory = this.ensurePlayerInventory(playerId);
    scene.inventory.add?.forEach((item) => {
      if (!inventory.includes(item)) {
        inventory.push(item);
      }
    });
    scene.inventory.remove?.forEach((item) => {
      const index = inventory.indexOf(item);
      if (index >= 0) {
        inventory.splice(index, 1);
      }
    });
  }

  private ensurePlayerSceneState(playerId: string): PlayerSceneState {
    if (!this.state.playerScenes[playerId]) {
      const initialScene = this.script && this.script.scenes.length ? this.script.scenes[0] : null;
      this.state.playerScenes[playerId] = this.buildPlayerSceneState(initialScene, playerId, this.state.gameStarted);
    }
    return this.state.playerScenes[playerId];
  }

  private buildPlayerSceneState(
    scene: ScriptScene | null,
    playerId: string,
    applyInventory: boolean
  ): PlayerSceneState {
    if (!scene) {
      return {
        sceneId: null,
        sceneText: '',
        availableOptions: [],
        diceRollRequired: false,
        rollState: null,
      };
    }
    const availableOptions = (scene.options ?? []).filter((option) =>
      this.checkFlagRequirements(option.flags)
    );
    if (applyInventory) {
      this.applySceneInventory(playerId, scene);
    }
    return {
      sceneId: scene.id,
      sceneText: scene.text,
      availableOptions,
      diceRollRequired: Boolean(scene.dice),
      rollState: this.buildRollState(scene),
    };
  }

  private buildRollState(scene: ScriptScene): RollState | null {
    if (!scene.roll) return null;
    return {
      count: scene.roll.count,
      type: scene.roll.type,
      sides: this.rollTypeToSides(scene.roll.type),
    };
  }

  private rollTypeToSides(type: string): number {
    if (!type.startsWith('d')) return 20;
    const value = parseInt(type.slice(1), 10);
    return Number.isNaN(value) ? 20 : value;
  }

  private calculateNextPosition(position: Position, direction: Direction): Position {
    const delta = { x: 0, y: 0 };
    switch (direction) {
      case 'up':
        delta.y = -1;
        break;
      case 'down':
        delta.y = 1;
        break;
      case 'left':
        delta.x = -1;
        break;
      case 'right':
        delta.x = 1;
        break;
    }
    return { x: position.x + delta.x, y: position.y + delta.y };
  }

  private log(message: string, playerId?: string) {
    const tag = playerId ? `[player:${playerId}] ` : '';
    this.state.log.push(`[${new Date().toISOString()}] ${tag}${message}`);
  }
}
