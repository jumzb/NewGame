export interface DiceResult {
  sides: number;
  quantity: number;
  rolls: number[];
  total: number;
}

export function rollDice(sides = 20, quantity = 1): DiceResult {
  const safeQuantity = Math.max(1, quantity);
  const rolls = Array.from({ length: safeQuantity }, () =>
    Math.floor(Math.random() * sides) + 1
  );
  const total = rolls.reduce((sum, roll) => sum + roll, 0);
  return { sides, quantity: safeQuantity, rolls, total };
}
