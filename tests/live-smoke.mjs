import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { loadCharacter, loadStory, loadCatalog } from '../wiki.js';
globalThis.DOMParser = DOMParser;

// 仅验证公开来源当前结构，不落盘、打印或分发原文。
const character = await loadCharacter('圣聆初雪');
assert.ok(character.sections.length >= 6);
assert.ok(character.images.length > 0);
assert.equal(character.characterId, 'char_1046_sbell2');
console.log(`Live character adapter: ${character.sections.length} sections, ${character.images.length} images`);
const story = await loadStory('0-7 感染/BEG');
assert.ok(story.entries.some(e => e.kind === 'choice'));
assert.ok(story.entries.some(e => e.kind === 'text'));
console.log(`Live story adapter: ${story.entries.length} structured entries`);
const catalog = await loadCatalog('剧情一览');
assert.ok(catalog.links.length > 50);
console.log(`Live catalog adapter: ${catalog.links.length} links`);
