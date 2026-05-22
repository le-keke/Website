#!/usr/bin/env node
// One-off migration: centralise scripts to assets/js/site.js and convert
// detail-page media to data-src for the new lazy loader.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const LIST_PAGES = ['index.html', 'research.html', 'about.html'];
const DETAIL_DIRS = ['work', 'research'];

const RE_INLINE_SCRIPT = /\s*<script>[\s\S]*?contextmenu[\s\S]*?<\/script>/i;
const RE_HEAD_CLOSE = /<\/head>/i;
const RE_COVER_OPEN = /<div\s+class="detail_cover"[^>]*>/i;

function findCoverRange(html) {
  const m = RE_COVER_OPEN.exec(html);
  if (!m) return null;
  const start = m.index;
  let i = m.index + m[0].length;
  let depth = 1;
  while (depth > 0 && i < html.length) {
    const nxtOpen = html.indexOf('<div', i);
    const nxtClose = html.indexOf('</div>', i);
    if (nxtClose === -1) return null;
    if (nxtOpen !== -1 && nxtOpen < nxtClose) {
      depth += 1;
      i = nxtOpen + 4;
    } else {
      depth -= 1;
      i = nxtClose + '</div>'.length;
    }
  }
  return [start, i];
}

function swapImg(tag) {
  return tag.replace(/\bsrc=(["'])(https?:\/\/[^"']+)\1/, 'data-src=$1$2$1');
}

function swapSource(tag) {
  return tag.replace(/\bsrc=(["'])(https?:\/\/[^"']+)\1/, 'data-src=$1$2$1');
}

function swapMediaAttrs(segment) {
  segment = segment.replace(/<img\b[^>]*>/gi, swapImg);
  segment = segment.replace(/<source\b[^>]*>/gi, swapSource);

  segment = segment.replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, (block) => {
    if (!block.includes('data-src=')) return block;
    const openMatch = /<video\b[^>]*>/i.exec(block);
    if (!openMatch) return block;
    let open = openMatch[0];
    if (!/\bdata-lazy\b/.test(open)) {
      open = open.replace(/>$/, ' data-lazy>');
    }
    if (/\bpreload=/i.test(open)) {
      open = open.replace(/\bpreload=(["'])[^"']*\1/i, 'preload="none"');
    } else {
      open = open.replace(/>$/, ' preload="none">');
    }
    return open + block.slice(openMatch[0].length);
  });

  return segment;
}

function injectScript(html, tag) {
  if (html.includes(tag)) return html;
  return html.replace(RE_HEAD_CLOSE, `    ${tag}\n    </head>`);
}

function stripInline(html) {
  return html.replace(RE_INLINE_SCRIPT, '');
}

function processFile(path) {
  const html = readFileSync(path, 'utf8');
  let out = html;

  const isDetail = dirname(path) !== ROOT;
  const relJs = isDetail ? '../assets/js/site.js' : './assets/js/site.js';
  const scriptTag = `<script src="${relJs}" defer></script>`;

  if (isDetail) {
    const range = findCoverRange(out);
    if (range) {
      const [s, e] = range;
      out = swapMediaAttrs(out.slice(0, s)) + out.slice(s, e) + swapMediaAttrs(out.slice(e));
    } else {
      out = swapMediaAttrs(out);
    }
  }

  out = stripInline(out);
  out = injectScript(out, scriptTag);

  if (out !== html) {
    writeFileSync(path, out, 'utf8');
    console.log(`updated: ${relative(ROOT, path)}`);
  } else {
    console.log(`skipped: ${relative(ROOT, path)}`);
  }
}

for (const f of LIST_PAGES) processFile(join(ROOT, f));
for (const d of DETAIL_DIRS) {
  const dir = join(ROOT, d);
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.html')) continue;
    const p = join(dir, name);
    if (statSync(p).isFile()) processFile(p);
  }
}
