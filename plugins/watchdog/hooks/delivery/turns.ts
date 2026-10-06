// §10.7: the main-loop turn counter of `turns_ago` and the cooldown (§10.4); `$.state` key `turns` keeps a
// copy (§14.1). A note keeps the value of the moment the watchdog makes it.
const memory: { turn: number } = { turn: 0 };

export const currentTurn = (): number => memory.turn;

// One main-loop `turn.start`: the counter adds 1 and returns the new value.
export const countTurn = (): number => {
  memory.turn += 1;
  return memory.turn;
};
