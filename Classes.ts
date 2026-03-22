export type Stats = {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
};

const DEFAULT_STATS: Stats = {
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
};

export interface AttackResult {
  roll: number;
  damage: number;
}

export function rollDice(sides = 20, quantity = 1): number {
  const actualQuantity = Math.max(1, quantity);
  const rolls = Array.from({ length: actualQuantity }, () =>
    Math.floor(Math.random() * sides) + 1
  );
  return rolls.reduce((total, current) => total + current, 0);
}

export class Item {
  /**
   * @param name descriptive label for the item
   * @param type categorizes the item (weapon, armor, potion, etc.)
   * @param value gold cost
   * @param effects arbitrary metadata/effects
   */
  constructor(
    public name: string,
    public type: string,
    public value = 0,
    public effects: Record<string, unknown> = {}
  ) {}
}

export class Character {
  hp: number;
  level: number;
  inventory: Item[];
  gold: number;
  stats: Stats;

  constructor(
    public name: string,
    public race: string,
    public charClass: string,
    stats: Partial<Stats> = {}
  ) {
    this.stats = { ...DEFAULT_STATS, ...stats };
    this.hp = 10 + this.stats.con;
    this.level = 1;
    this.inventory = [];
    this.gold = 0;
  }

  takeDamage(amount: number) {
    this.hp = Math.max(0, this.hp - amount);
  }

  heal(amount: number) {
    this.hp += amount;
  }

  addItem(item: Item) {
    this.inventory.push(item);
  }

  removeItem(itemName: string) {
    const index = this.inventory.findIndex((item) => item.name === itemName);
    if (index >= 0) {
      this.inventory.splice(index, 1);
    }
  }

  attack(target?: Character): AttackResult {
    const roll = rollDice(20);
    return {
      roll,
      damage: this.stats.str + roll,
    };
  }
}

export class NPC extends Character {
  dialogue: string[];
  currentQuest?: string;
  constructor(
    name: string,
    race: string,
    public role: string,
    dialogue: string[] = [],
    stats: Partial<Stats> = {}
  ) {
    super(name, race, role, stats);
    this.dialogue = dialogue;
  }

  speak(index = 0): string {
    if (!this.dialogue.length) return '';
    return this.dialogue[index % this.dialogue.length];
  }

  giveQuest(quest: string) {
    this.currentQuest = quest;
  }
}

export class Enemy extends Character {
  lootTable: Item[] = [];
  constructor(
    name: string,
    type: string,
    public threatLevel = 1,
    stats: Partial<Stats> = {}
  ) {
    super(name, type, type, stats);
  }

  setLootTable(items: Item[]) {
    this.lootTable = items;
  }

  dropLoot(): Item | null {
    if (!this.lootTable.length) return null;
    const index = Math.floor(Math.random() * this.lootTable.length);
    return this.lootTable[index];
  }
}

export interface ShopItemSummary {
  name: string;
  type: string;
  value: number;
}

export class Shop {
  inventory: Item[];
  gold: number;

  constructor(
    public name: string,
    inventory: Item[] = [],
    startingGold = 1000
  ) {
    this.inventory = inventory;
    this.gold = startingGold;
  }

  listGoods(): ShopItemSummary[] {
    return this.inventory.map((item) => ({
      name: item.name,
      type: item.type,
      value: item.value,
    }));
  }

  buy(itemName: string, buyer: Character): Item | null {
    const itemIndex = this.inventory.findIndex((item) => item.name === itemName);
    if (itemIndex === -1) return null;

    const item = this.inventory[itemIndex];
    if (buyer.gold < item.value) return null;

    buyer.gold -= item.value;
    this.gold += item.value;
    this.inventory.splice(itemIndex, 1);
    buyer.addItem(item);
    return item;
  }

  sell(item: Item, seller: Character): boolean {
    const price = Math.floor(item.value * 0.5);
    if (this.gold < price) return false;
    seller.gold += price;
    this.gold -= price;
    this.inventory.push(item);
    return true;
  }
}

