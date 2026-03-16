import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countCompletionMarkerOccurrences,
  hasRepeatedCompletionMarker,
  normalizeCompletionMarkerText,
} from './completion-marker.js';

const marker = 'CONTROL_LAYER_DONE:packet-4';

test('exact marker twice is complete', () => {
  const output = `header\n${marker}\nmore logs\n${marker}\n`;
  assert.equal(hasRepeatedCompletionMarker(output, marker), true);
});

test('marker once only is not complete', () => {
  const output = `header\n${marker}\nmore logs\n`;
  assert.equal(hasRepeatedCompletionMarker(output, marker), false);
});

test('instruction mention plus agent output mention is complete', () => {
  const output = [
    `Instruction: Print ${marker} exactly once when done.`,
    'Agent executing...',
    `Final: ${marker}`,
  ].join('\n');

  assert.equal(hasRepeatedCompletionMarker(output, marker), true);
});

test('wrapped marker across line breaks is complete after normalization', () => {
  const output = [
    'Instruction:',
    'CONTROL_LAYER_DONE:',
    'packet-4',
    'Agent done:',
    marker,
  ].join('\n');

  assert.equal(hasRepeatedCompletionMarker(output, marker), true);
});

test('marker split by spaces and hyphen wrapping is complete after normalization', () => {
  const output = [
    'Instruction:',
    'CONTROL_LAYER_DONE : packet-',
    '4',
    'Agent done:',
    'CONTROL_LAYER_DONE : packet - 4',
  ].join('\n');

  assert.equal(hasRepeatedCompletionMarker(output, marker), true);
});

test('similar but non-identical marker text is not complete', () => {
  const similarMarker = 'CONTROL_LAYER_DONE:packet-44';
  const output = `${similarMarker}\n${similarMarker}\n`;
  assert.equal(hasRepeatedCompletionMarker(output, marker), false);
});

test('unrelated repeated text without full marker is not complete', () => {
  const output = 'CONTROL_LAYER\nCONTROL_LAYER\npacket-4\npacket-4\n';
  assert.equal(hasRepeatedCompletionMarker(output, marker), false);
});

test('normalization removes soft-wrap hyphenation and collapses separators', () => {
  const normalized = normalizeCompletionMarkerText(' CONTROL_LAYER_DONE : pack-\n et-4 ');
  assert.equal(normalized, 'CONTROL_LAYER_DONE:packet4');
});

test('occurrence counting returns zero for empty normalized marker', () => {
  assert.equal(countCompletionMarkerOccurrences('anything', ' \n\t '), 0);
});
