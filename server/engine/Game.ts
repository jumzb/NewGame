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
} from '../../shared/types';
import { rollDice, DiceResult } from './Dice';
import Ajv, { JSONSchemaType } from 'ajv';
import scriptSchema from '../../shared/scriptSchema.json';

interface ScriptProgress {
  scriptId: string;
  step: number;
  message: string;
}

const ajv = new Ajv({ strict: false });
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
      order: this.nextOrder++,
    };
    this.state.players[id] = player;
    this.state.map.totalPlayers = Object.keys(this.state.players).length;
    this.ensureTurnOrder();
    this.log(`${displayName} joined the table.`);
    return player;
  }

  removePlayer(id: string) {
    const player = this.state.players[id];
    if (!player) return;
    delete this.state.players[id];
    this.state.map.totalPlayers = Object.keys(this.state.players).length;
    this.ensureTurnOrder();
    this.log(`${player.displayName} disconnected.`);
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
      `${player.displayName} moved ${direction} to (${player.position.x}, ${player.position.y}).`
    );
  }

  rollForPlayer(id: string): DiceResult | null {
    if (
      !this.state.gameStarted ||
      this.state.currentTurnId !== id ||
      !this.state.diceRollRequired ||
      !this.state.currentRoll
    ) {
      return null;
    }
    const player = this.state.players[id];
    const rollSpec = this.state.currentRoll;
    if (!player || !rollSpec) return null;
    const result = rollDice(rollSpec.sides, rollSpec.count);
    const message = `${player.displayName} rolled ${result.total} (${result.rolls.join(', ')}) on ${result.quantity}d${result.sides}.`;
    this.log(message);
    this.advanceTurn();
    return result;
  }

  runScriptAction(id: string, scriptId: string, step: number): ScriptProgress | null {
    if (!this.state.gameStarted || this.state.currentTurnId !== id) return null;
    const player = this.state.players[id];
    if (!player) return null;
    this.scriptProgress[scriptId] = step;
    const message = `${player.displayName} advanced script ${scriptId} to step ${step}.`;
    this.log(message);
    return { scriptId, step, message };
  }

  claimMaster(id: string): boolean {
    if (!this.hasPlayer(id)) return false;
    if (this.state.masterId && this.state.masterId !== id) return false;
    if (this.state.masterId === id) return true;
    this.state.masterId = id;
    this.log(`${this.state.players[id].displayName} claimed the master seat.`);
    return true;
  }

  startGame(): boolean {
    if (this.state.gameStarted) return false;
    if (!this.state.masterId || !this.state.players[this.state.masterId]) return false;
    if (!this.state.turnOrder.length) return false;
    this.state.gameStarted = true;
    this.currentTurnIndex = 0;
    this.state.currentTurnId = this.state.turnOrder[this.currentTurnIndex];
    this.state.nextTurnId =
      this.state.turnOrder[(this.currentTurnIndex + 1) % this.state.turnOrder.length] ?? null;
    const masterName = this.state.players[this.state.masterId].displayName;
    this.log(`${masterName} started the game.`);
    return true;
  }

  loadScript(script: Script) {
    if (!validateScript(script)) {
      const errors = validateScript.errors
        ? validateScript.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')
        : 'schema validation failed';
      throw new Error(`Script validation error: ${errors}`);
    }
    this.script = script;
    if (!script.scenes.length) {
      this.setSceneState(null);
      return;
    }
    this.setSceneState(script.scenes[0]);
    this.log(`Script loaded. Current scene: ${script.scenes[0].id}`);
  }

  chooseOption(playerId: string, optionIndex: number): ScriptScene | null {
    if (!this.script || !this.state.gameStarted || this.state.currentTurnId !== playerId) return null;
    const current = this.getCurrentScene();
    if (!current?.options?.length) return null;
    const option = current.options[optionIndex];
    if (!option) return null;
    const nextScene = this.getSceneById(option.goto);
    if (!nextScene) return null;
    this.setSceneState(nextScene);
    const playerName = this.state.players[playerId]?.displayName ?? 'Unknown';
    this.log(`${playerName} chose "${option.text}"`);
    return nextScene;
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
      this.log(`${player.displayName} is now up for the roll.`);
    }
  }

  private getSceneById(id: string): ScriptScene | undefined {
    return this.script?.scenes.find((scene) => scene.id === id);
  }

  private getCurrentScene(): ScriptScene | undefined {
    if (!this.state.currentSceneId) return undefined;
    return this.getSceneById(this.state.currentSceneId);
  }

  private setSceneState(scene: ScriptScene | null) {
    if (!scene) {
      this.state.currentSceneId = null;
      this.state.currentText = '';
      this.state.availableOptions = [];
      this.state.diceRollRequired = false;
      this.state.currentRoll = null;
      return;
    }
    this.state.currentSceneId = scene.id;
    this.state.currentText = scene.text;
    this.state.availableOptions = scene.options ?? [];
    this.state.diceRollRequired = Boolean(scene.dice);
    this.state.currentRoll = this.buildRollState(scene);
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

  private log(message: string) {
    this.state.log.push(`[${new Date().toISOString()}] ${message}`);
  }
}
