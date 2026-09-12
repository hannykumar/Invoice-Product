/**
 * Issue #147 — builds the picture library that a business picks its mark from.
 *
 * The pictures are Tabler Icons (MIT, © Paweł Kuna), a free open set of about five thousand line
 * drawings. They are **copied into this repository** by this script rather than fetched at run
 * time, for three reasons: a bill must print with no internet, a business's chosen mark must never
 * change shape because a library was upgraded, and the drawings have to stay readable at watermark
 * size, which is a property of the file we ship rather than of whatever version npm resolves.
 *
 * Run it with:  npm run marks:build
 *
 * What is left out, and why:
 *  - Other companies' logos (`Brand`). Printing another company's mark on your own bill is wrong.
 *  - Letters, numbers, arrows, chevrons and the rest of the screen furniture. A watermark is a
 *    picture of a thing, not a user-interface control.
 *  - The crossed-out "-off" variants, which say a thing is *not* there. On a bill that reads as a
 *    denial of the trade.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELD_SEPARATOR, PATH_SEPARATOR } from '../../packages/invoice-templates/src/marks-format.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const source = join(root, 'node_modules', '@tabler', 'icons');
const target = join(root, 'packages', 'invoice-templates', 'src', 'marks-library.generated.ts');

/** Whole families of drawings that are never a mark of a trade. */
const SKIPPED_GROUPS = new Set([
  'Brand', 'Letters', 'Numbers', 'Math', 'Logic', 'Version control',
  'Charts', 'Zodiac', 'Gender', 'Mood', 'Gestures', 'Arrows', 'Text', 'Symbols', 'Badges',
]);

/** Screen furniture that slips through the grouping above. */
const SKIPPED_NAMES =
  /^(chevron|arrow|caret|player|layout|align|border|square-rounded|circle-|square-|triangle-|box-model|box-padding|box-margin|box-align)/;

/**
 * The same drawing again with a little badge stuck on it — a tick, a cross, a cog, a heart.
 *
 * The set carries dozens of these for every object, because on a screen they mean "added",
 * "removed", "settings". On a bill they mean nothing, and they bury the plain drawing a business
 * is actually looking for under twenty variants of itself.
 */
const BADGE_SUFFIX =
  /-(x|check|plus|minus|cancel|cog|pin|bolt|code|dollar|edit|exclamation|question|heart|star|search|share|pause|play|up|down|left|right|filled|discount|shield|spark|ai)$/;

interface IconMeta {
  readonly category?: string;
  readonly tags?: readonly (string | number)[];
}

const metaPath = join(source, 'icons.json');
if (!existsSync(metaPath)) {
  throw new Error(
    'The icon set is not installed. Run `npm install` first — @tabler/icons is a development ' +
      'dependency, needed only to rebuild this library.',
  );
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, IconMeta>;

/** The empty square Tabler puts around every drawing. It is not part of the picture. */
const FRAME = 'M0 0h24v24H0z';

const rows: string[] = [];

for (const [name, icon] of Object.entries(meta)) {
  if (icon.category !== undefined && SKIPPED_GROUPS.has(icon.category)) continue;
  if (SKIPPED_NAMES.test(name)) continue;
  if (name.endsWith('-off')) continue;
  if (BADGE_SUFFIX.test(name)) continue;

  const file = join(source, 'icons', 'outline', `${name}.svg`);
  if (!existsSync(file)) continue;

  const svg = readFileSync(file, 'utf8');
  const paths = [...svg.matchAll(/ d="([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((d) => !d.startsWith(FRAME));
  if (paths.length === 0) continue;

  // The words someone might type to find this picture: the drawing's own name, the group it sits
  // in, and the set's own tags. Worked out once here so that searching never rebuilds them.
  const words = new Set<string>();
  const add = (value: string): void => {
    for (const part of value.split(/[\s&/-]+/)) if (part !== '') words.add(part.toLowerCase());
  };
  add(name);
  if (icon.category !== undefined) add(icon.category);
  for (const tag of icon.tags ?? []) add(String(tag));

  // One picture, one line: id, then the words, then the drawing. Held as a string rather than as
  // an object literal so that a library of a couple of thousand pictures stays a file the compiler can
  // read quickly, and so a diff shows one changed picture as one changed line.
  rows.push([name, [...words].join(' '), paths.join(PATH_SEPARATOR)].join(FIELD_SEPARATOR));
}

rows.sort();

/** Only three characters can end a template literal early, and none of them is in path data. */
const escape = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replaceAll(FIELD_SEPARATOR, '\\u0001')
    .replaceAll(PATH_SEPARATOR, '\\u0002');

const version = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version: string }).version;

const out = `/**
 * Issue #147 — the picture library. Generated; do not edit by hand.
 *
 * Rebuild with:  npm run marks:build
 *
 * ${rows.length} line drawings from Tabler Icons v${version}, MIT licensed, © 2020-2026 Paweł Kuna.
 * The licence is reproduced at packages/invoice-templates/THIRD-PARTY-LICENCES.md.
 *
 * Each line is one picture: its id, the words it can be found by, and the drawing itself. See
 * marks.ts for how a line is read.
 */

export const TRADE_MARK_LIBRARY_VERSION = 'tabler-${version}';

export const TRADE_MARK_LIBRARY_ROWS: readonly string[] = [
${rows.map((r) => '  `' + escape(r) + '`,').join('\n')}
];
`;

writeFileSync(target, out);
console.log(`Wrote ${rows.length} pictures to ${target} (${Math.round(out.length / 1024)} KB).`);
