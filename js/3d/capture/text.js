// Capture Mala Tokmachka: names, colours and the jokey log. Pure.
// Templates are picked by the event's seq, so the host and every guest print the
// same line. The jokes are about being towed, fed, scattered or sent home: never
// about casualties (this is a real front-line village).

export const SIDES = {
    us: { name: 'US', long: 'United States', color: '#2f74e8', perk: 'Freedom Express', blurb: 'Columns march 45% faster' },
    cn: { name: 'China', long: 'China', color: '#f0b90b', perk: 'Made in Mala Tokmachka', blurb: 'Blocks produce 15% faster' },
    ru: { name: 'Russia', long: 'Russia', color: '#d8362f', perk: 'Human wave', blurb: '1.7× the troops, each worth 0.65' },
};
export const NEUTRAL = { name: 'Locals', color: '#9b9b93' };

export const UPGRADES = [
    { key: 'spawn', name: 'Barracks', short: '+50% troops', hint: '+50% production, +30% cap', hotkey: 'Z' },
    { key: 'def', name: 'Sandbags', short: '+30% defence', hint: '+30% garrison strength', hotkey: 'X' },
    { key: 'atk', name: 'Gym', short: '+25% attack', hint: '+25% strength for columns leaving here', hotkey: 'C' },
];

const NAMES = [
    'Goat Corner', 'Cherry Orchard', 'Pickle Row', 'Babusya HQ', 'Tractor Depot', 'Sunflower Field',
    'Village Club', 'Old Well', 'Bus Stop', 'Post Office', 'Beehives', 'Duck Pond', 'Potato Patch',
    'Grain Store', 'Church Hill', 'School Yard', 'Shop "Produkty"', 'Cow Lane', 'Cabbage Rows',
    'Rooster Ridge', 'Smokehouse', 'Plum Trees', 'Hay Barn', 'Melon Patch', 'Water Tower',
    'Garage Co-op', 'Chicken Coop', 'Apricot Alley', 'Dacha Row', 'Collective Farm', 'Fire Station',
    'Pumpkin Patch', 'Fishing Spot', 'Bakery', 'Old Mill', 'Kolkhoz Office', 'Linden Lane',
    'Horse Paddock', 'Garlic Beds', 'Bus Shelter', 'Pharmacy', 'Haystacks', 'Vineyard',
    'Gooseberry Bushes', 'Pig Farm', 'Cultural Centre', 'Cemetery Road', 'Mushroom Wood',
    'Sauna', 'Tomato Greenhouses', 'Rabbit Hutches', 'Corn Field', 'Village Council', 'Kiosk',
    'Bicycle Shed', 'Walnut Tree', 'Tool Shed', 'Cellar Row', 'Riverside', 'Dog Kennel',
    'Football Pitch', 'Silo', 'Wheat Field', 'Bus Turnaround', 'Watermelon Patch', 'Honey Farm',
];

/** Short, stable nickname for block id i. */
export function blockName(i) {
    return NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : '');
}

export const TITLES = ['Mayor of Mala Tokmachka', 'Deputy Mayor for Potholes', 'Chief Goat Inspector'];

const sideName = f => (f ? SIDES[f].name : 'the locals');

const LINES = {
    start: ['{F} moved into {B}.', '{F} set up camp in {B}.'],
    capture: [
        '{F} took {B} from {P}.',
        '{F} kicked {P} out of {B}.',
        '{B} now belongs to {F}. The goats are unimpressed.',
        '{F} planted a flag in {B}. {P} went to complain at the village council.',
    ],
    clash: [
        'Street fight on the way to {B}: {F} sent {N} {P} troops home.',
        '{F} and {P} met in a lane near {B}. {F} kept the lane.',
        '{F} ambushed a {P} column ({N}) heading for {B}.',
    ],
    tractor: [
        'A Ukrainian tractor towed away {N} {F} troops heading for {B}.',
        'Tractor 1, {F} 0: {N} troops towed to the next oblast.',
        'A farmer hitched {N} {F} troops to his tractor. Last seen near {B}.',
    ],
    babusya: [
        'Babusya fed the {F} garrison in {B}: +{N}, all of them full of borscht.',
        'Varenyky delivered to {B}. {F} gets +{N} very motivated troops.',
        'A babusya in {B} adopted {N} new grandsons for {F}.',
    ],
    mud: [
        'Mud season! Everyone marches at half speed for 30 s.',
        'Rasputitsa: the lanes of Mala Tokmachka eat boots. Half speed for 30 s.',
    ],
    mavic: [
        'A Mavic dropped something on a {F} column. {N} ran home.',
        '{N} {F} troops scattered by a Mavic on the road to {B}.',
    ],
    upgrade: ['{F} built {U} in {B}.', '{F} invested in {U} for {B}.'],
    rally: ['{F} set a gathering point at {B}.', '{F} told everyone to meet at {B}.'],
    win: ['{F} is the new Mayor of Mala Tokmachka!'],
};

/** Log line for an event from sim.js's log. */
export function eventLine(ev) {
    const list = LINES[ev.type];
    if (!list) return '';
    const tpl = list[ev.seq % list.length];
    return tpl
        .replaceAll('{F}', sideName(ev.f))
        .replaceAll('{P}', sideName(ev.other))
        .replaceAll('{B}', ev.block == null ? '' : blockName(ev.block))
        .replaceAll('{N}', String(Math.round(ev.n ?? 0)))
        .replaceAll('{U}', ev.track == null ? '' : UPGRADES[ev.track].name.toLowerCase())
        .replace(/(^|[.!?:]\s+)([a-z])/g, (m, gap, c) => gap + c.toUpperCase());
}

export function formatClock(t) {
    const s = Math.max(0, Math.floor(t));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
