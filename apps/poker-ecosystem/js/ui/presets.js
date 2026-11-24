// Spot presets for the solver tab. Ranges are sized so a solve takes seconds in a browser.
const menu = (bets, raises = [1], max = 2, allin = 0.67) => ({ bets, raises, max_raises: max, allin_threshold: allin, add_allin: false });

export const PRESETS = [
  {
    name: 'NLH single-raised pot river: BB vs BTN on Q♠8♥5♦3♣2♠',
    note: 'A 6.5 bb single-raised pot on the river. The big blind defends wide; the button\'s range here is strong (sets and overpairs), so at equilibrium the big blind checks everything. Tell the solver the button folds too often and watch the big blind start betting.',
    iters: 800,
    profile: { mp: 1, fold: 0.7, raise: 0.03, stab: 0.5, bluff: 0.33 },
    config: { game: 'NLH', board: 'Qs8h5d3c2s', ranges: ['22-JJ,A2s-AJs,K9s-KJs,Q8s+,J8s+,T8s+,97s+,86s+,75s+,64s+,54s,A8o-AJo,KTo+,QTo+,JTo', 'TT+,AQs+,AKo,KQs,QJs,JTs,T9s,98s,A5s,A4s,Q8s,88,55,33,22,KQo,QJo'], pot: 6.5, stacks: [97], menu: menu([0.33, 0.75]) },
  },
  {
    name: 'NLH 3-bet pot river: A♥9♦4♣4♠2♥',
    note: 'A 22 bb pot; the out-of-position 3-bettor holds the stronger range.',
    iters: 800,
    profile: { mp: 1, fold: 0.6, raise: 0.02, stab: 0.4, bluff: 0.3 },
    config: { game: 'NLH', board: 'Ah9d4c4s2h', ranges: ['QQ+,AKs,AKo,AQs,A5s,A4s,KQs,JTs:0.5,T9s:0.5', 'JJ-99,AQs,AJs,ATs,KQs,KJs,QJs,JTs,T9s,98s,87s,76s,AQo'], pot: 22, stacks: [78], menu: menu([0.33, 0.75]) },
  },
  {
    name: 'Closed-form check: nuts or air against bluff-catchers',
    note: 'Out of position holds quads or air that plays the board; in position holds hands that beat only the air. Game theory says: bet all quads, bluff half the air with a pot-sized bet, call half the time. The solver should land there.',
    iters: 2000,
    profile: { mp: 1, fold: 0.8, raise: 0, stab: 0, bluff: 0.3 },
    config: { game: 'NLH', board: '2s2c2d7h7c', ranges: ['2h3c,2h4c,2h5c,2h6c,3d4d,3h4h,5d6d,5h6h', '8s8d,8h8c,9s9d,9h9c'], pot: 10, stacks: [100], menu: menu([1.0], [], 1, 1.0) },
  },
  {
    name: 'The 7-2 game: a 5 bb bounty for winning with seven-deuce',
    note: 'Whoever wins a pot holding 7-2 offsuit collects 5 bb from the opponent. Watch how the defender calls wider and what seven-deuce does with the bounty in play.',
    iters: 800,
    profile: { mp: 1, fold: 0.6, raise: 0.02, stab: 0.4, bluff: 0.3 },
    config: { game: 'NLH', board: 'Ts9c4h3d3s', ranges: ['AA,KK,AQs,72o,64s,53s,A5s,KQs', 'QQ-TT,AJs,KQs,98s,JTs,T9s,99'], pot: 10, stacks: [40], menu: menu([0.5, 1.0]), side_rule: { kind: 'seven_deuce', amount: 5 } },
  },
  {
    name: 'Double-board river (each board is worth half the pot)',
    note: 'A bomb-pot style double board: hands must be judged on both boards at once.',
    iters: 600,
    profile: { mp: 1, fold: 0.6, raise: 0.02, stab: 0.5, bluff: 0.3 },
    config: { game: 'NLH', board: 'Ks7d2c9h4s', board2: 'As8s3d5c6h', ranges: ['AA,KQ,JTs,99,A5s,T8s,K9s,87s', 'QQ,K9s,AK,T8s,66,A3s,98s,KJs'], pot: 20, stacks: [60], menu: menu([0.5, 1.0]) },
  },
  {
    name: 'Pot-Limit Omaha river: K♥9♥6♦3♣2♠',
    note: 'Four-card hands: card removal is exact through 15 subset terms per hand.',
    iters: 400,
    profile: { mp: 1, fold: 0.6, raise: 0.02, stab: 0.5, bluff: 0.3 },
    config: { game: 'PLO', board: 'Kh9h6d3c2s', ranges: ['KKxx:0.05,99xx:0.05,KQJT,QJT8,T875,AhQhxx:0.02,JT87', 'AKxx:0.01,QQJT,JJT9,T987,8754,QJT9,KQxx:0.01'], pot: 10, stacks: [45], menu: menu([0.5, 1.0]) },
  },
  {
    name: 'Short Deck river (trips beat straights)',
    note: '36-card deck: A-6-7-8-9 is the lowest straight and flushes beat full houses.',
    iters: 800,
    profile: { mp: 1, fold: 0.6, raise: 0.02, stab: 0.5, bluff: 0.3 },
    config: { game: 'SD', board: 'Ah9d8c7s6h', ranges: ['TT+,AK,AQ,KQ,JT,T9s,98s,A9s', '99+,AJ,KJ,QJ,T9s,87s,KTs'], pot: 10, stacks: [50], menu: menu([0.5, 1.0]) },
  },
  {
    name: 'Omaha Hi-Lo river: split pots with an 8-or-better low',
    note: 'Half the pot goes to the best qualifying low; the high hand scoops when no low qualifies.',
    iters: 400,
    profile: { mp: 1, fold: 0.6, raise: 0.02, stab: 0.5, bluff: 0.3 },
    config: { game: 'O8', board: 'Ah4d7c9sKs', ranges: ['A2xxds:0.5,A3xxds:0.5,KKQJ', 'AKxxds:0.3,23xxds,QJT9'], pot: 10, stacks: [30], menu: menu([0.75]) },
  },
  {
    name: 'NLH turn: K♠7♦2♣9♥ (every river card solved)',
    note: 'A turn spot enumerates all 44 river cards with exact card removal. Slower in a browser: about a minute.',
    iters: 150,
    profile: { mp: 1, fold: 0.6, raise: 0.02, stab: 0.5, bluff: 0.3 },
    config: { game: 'NLH', board: 'Ks7d2c9h', ranges: ['AA,KQs,98s,T8s,KJs,QQ', 'QQ,K9s,T9s,JTs,99,A9s'], pot: 10, stacks: [40], menu: menu([0.75], [1], 1) },
  },
];
