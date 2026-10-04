/**
 * Plan revisions: an append-only, hash-chained record of exceptions (docs/PLAN-REVISIONS.md).
 *
 * Mirrors `packvium-python/tests/test_revisions.py` and `PlanRevisionTest.php`. The module is
 * imported by package name, so a missing `exports` entry fails here and not only in a
 * consumer's project. Refusal messages are asserted whole: they are compared across engines.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { SUITE_VERSION, buildOperationalArtifact } from '@packvium/engine/artifacts.js';
import {
  FORMAT, PlanRevisionError, applyEvents, canonicalRevisionJson, deriveRevision, documentDigest,
  rootRevision, verifyRevisionChain,
} from '@packvium/engine/revisions.js';
import { packFallback } from '../fallback.js';

function cubeRequest() {
  return {
    items: [
      { id: 'cube', quantity: 4, weight: '1000', dimensions: { length: '100', width: '100', height: '100' } },
      { id: 'slab', quantity: 1, dimensions: { length: '200', width: '100', height: '50' } },
    ],
    containers: [
      { id: 'box', quantity: 3, inner_dimensions: { length: '200', width: '100', height: '200' } },
      { id: 'crate', inner_dimensions: { length: '300', width: '200', height: '200' } },
    ],
    configuration: { solver_profile: 'balanced', minimum_support_ratio: 1.0 },
  };
}

const artifactFor = (request) => buildOperationalArtifact(request, packFallback(request));

const locked = ({ x = '0', z = '0', kind = 'placement_locked', sequence = 1 } = {}) => ({
  sequence, type: kind, placement: { item_type: 'cube', container_type: 'box', position: { x, z }, orientation: 'LWH' },
});

function chain() {
  const root = rootRevision(cubeRequest());
  const firstArtifact = artifactFor(root.request);
  const first = deriveRevision(root, firstArtifact, [
    locked(), { sequence: 2, type: 'item_missing', item_type: 'cube', quantity: 1 },
  ]);
  const secondArtifact = artifactFor(first.request);
  const second = deriveRevision(first, secondArtifact, [locked({ kind: 'placement_verified', sequence: 3 })]);
  return [[root, first, second], [null, firstArtifact, secondArtifact]];
}

const copy = (value) => JSON.parse(JSON.stringify(value));
const codes = (revisions, artifacts = null) => new Set(verifyRevisionChain(revisions, artifacts).map((entry) => entry.code));

function refused(action, code, message) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PlanRevisionError, `${error.name}: ${error.message}`);
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

test('the root records nothing against the request', () => {
  assert.deepEqual(rootRevision(cubeRequest()), {
    format: FORMAT, suite_version: SUITE_VERSION, revision: 0, parent: null, approved: null, events: [],
    request: cubeRequest(),
  });
});

test('a revision links its parent and approved artifact by digest', () => {
  const [[root, first], artifacts] = chain();
  assert.equal(first.revision, 1);
  assert.equal(first.parent, documentDigest(root));
  assert.equal(first.approved.artifact, documentDigest(artifacts[1]));
  assert.deepEqual(first.approved.replay, artifacts[1].provenance.replay);
});

test('a digest is sha256 over the canonical bytes', () => {
  const root = rootRevision(cubeRequest());
  const expected = createHash('sha256').update(Buffer.from(canonicalRevisionJson(root), 'utf8')).digest('hex');
  assert.equal(documentDigest(root), `sha256:${expected}`);
  assert.match(documentDigest(root), /^sha256:[0-9a-f]{64}$/);
});

test('transport spelling never changes a digest', () => {
  const root = rootRevision(cubeRequest());
  const reparsed = JSON.parse(JSON.stringify(root, null, 4));
  reparsed.request.configuration.minimum_support_ratio = 1;
  assert.equal(documentDigest(reparsed), documentDigest(root));
});

test('the same inputs derive the same bytes', () => {
  const [first] = chain();
  const [second] = chain();
  assert.deepEqual(first.map(canonicalRevisionJson), second.map(canonicalRevisionJson));
});

test('building never mutates the caller\'s documents', () => {
  const request = cubeRequest();
  const root = rootRevision(request);
  const artifact = artifactFor(root.request);
  const before = [JSON.stringify(root), JSON.stringify(artifact)];
  const events = [locked()];
  deriveRevision(root, artifact, events);
  assert.deepEqual([JSON.stringify(root), JSON.stringify(artifact)], before);
  assert.deepEqual(events, [locked()]);
  assert.deepEqual(request, cubeRequest());
});

test('a missing item lowers its quantity and a last one removes the type', () => {
  const request = cubeRequest();
  const lowered = applyEvents(request, [{ sequence: 1, type: 'item_missing', item_type: 'cube', quantity: 3 }]);
  assert.equal(lowered.items[0].quantity, 1);
  const removed = applyEvents(request, [{ sequence: 1, type: 'item_missing', item_type: 'slab', quantity: 1 }]);
  assert.deepEqual(removed.items.map((item) => item.id), ['cube']);
  assert.deepEqual(request, cubeRequest());
});

test('a substituted container is replaced where it stood', () => {
  const replacement = { id: 'box-b', inner_dimensions: { length: '210', width: '110', height: '210' } };
  const derived = applyEvents(cubeRequest(), [{ sequence: 1, type: 'container_substituted', container_type: 'box', replacement }]);
  assert.deepEqual(derived.containers.map((container) => container.id), ['box-b', 'crate']);
});

test('a lock then a verification of the same box fixes it once', () => {
  const derived = applyEvents(cubeRequest(), [locked(), locked({ kind: 'placement_verified', sequence: 2 })]);
  assert.deepEqual(derived.fixed_placements, [locked().placement]);
});

test('a fixed set with no canonical form still deduplicates by first match', () => {
  const unholdable = locked({ x: '5' }).placement;
  unholdable.position.x = 2 ** 60;
  const request = { ...cubeRequest(), fixed_placements: [locked().placement, unholdable] };
  const derived = applyEvents(request, [locked()]);
  assert.deepEqual(derived.fixed_placements, [locked().placement, unholdable]);
});

test('a lock with no canonical form is recorded for admission to judge', () => {
  const event = locked();
  event.placement.position.x = 2 ** 60;
  const derived = applyEvents(cubeRequest(), [event]);
  assert.deepEqual(derived.fixed_placements, [event.placement]);
});

test('a lock without a position is a lock at the origin', () => {
  const event = locked();
  delete event.placement.position;
  const derived = applyEvents(cubeRequest(), [event]);
  assert.deepEqual(derived.fixed_placements, [event.placement]);
});

test('an explicit first instance and the default one are the same box', () => {
  const explicit = locked({ sequence: 2 });
  explicit.placement.container_instance = 1;
  const derived = applyEvents(cubeRequest(), [locked(), explicit]);
  assert.deepEqual(derived.fixed_placements, [locked().placement]);
});

test('a derived request solves with its fixed items in place', () => {
  const [revisions] = chain();
  const result = packFallback(revisions.at(-1).request);
  const fixed = result.containers.flatMap((container) => container.placements
    .filter((placement) => placement.fixed).map((placement) => [container.id, placement.item_id]));
  assert.deepEqual(fixed, [['box#1', 'cube#1']]);
  assert.equal(result.containers.reduce((total, container) => total + container.placements.length, 0), 4);
});

for (const [name, event, message] of [
  ['an unknown item', { sequence: 1, type: 'item_missing', item_type: 'pallet', quantity: 1 }, 'the request has no item "pallet"'],
  ['a replacement id that exists', { sequence: 1, type: 'container_substituted', container_type: 'box',
    replacement: { id: 'crate', inner_dimensions: { length: 1, width: 1, height: 1 } } }, 'event 1: another container is already crate'],
  ['a substitution of an unknown container', { sequence: 1, type: 'container_substituted', container_type: 'pallet',
    replacement: { id: 'p2' } }, 'the request has no container "pallet"'],
]) {
  test(`an event that contradicts the request is refused: ${name}`, () => {
    refused(() => applyEvents(cubeRequest(), [event]), 'event_conflict', message);
  });
}

test('fixed items cannot go missing or lose their container', () => {
  const fixed = applyEvents(cubeRequest(), [locked()]);
  refused(() => applyEvents(fixed, [{ sequence: 2, type: 'item_missing', item_type: 'cube', quantity: 4 }]),
    'event_conflict', 'event 2: 1 cube are fixed, 0 would remain');
  refused(() => applyEvents(fixed, [{ sequence: 2, type: 'container_substituted', container_type: 'box',
    replacement: { id: 'box-b', inner_dimensions: { length: 1, width: 1, height: 1 } } }]),
  'event_conflict', 'event 2: fixed placements are in box');
});

test('the last item type cannot go missing', () => {
  const request = cubeRequest();
  request.items = request.items.slice(0, 1);
  refused(() => applyEvents(request, [{ sequence: 1, type: 'item_missing', item_type: 'cube', quantity: 4 }]),
    'event_conflict', 'event 1: no item would remain to pack');
});

const MALFORMED_EVENTS = [
  [[], 'a revision records at least one event'],
  [[locked({ sequence: 2 })], 'event sequence 2 does not continue the chain at 1'],
  [[{ ...locked(), type: 'placement_moved' }], 'unknown event type "placement_moved"'],
  [[{ ...locked(), note: 'strapped' }], 'placement_locked does not carry ["note"]'],
  [[{ sequence: 1, type: 'item_missing', item_type: 'cube' }], 'item_missing needs ["quantity"]'],
  [[{ sequence: 1, type: 'item_missing', item_type: 'cube', quantity: 0 }], 'item_missing.quantity is a positive integer'],
  [[{ sequence: true, type: 'item_missing', item_type: 'cube', quantity: 1 }], 'event sequence true does not continue the chain at 1'],
  [[{ sequence: 1, type: 'placement_locked', placement: { ...locked().placement, orientation: 'XYZ' } }],
    'placement.orientation is one of the six codes'],
  [[{ sequence: 1, type: 'placement_locked', placement: { ...locked().placement, container_instance: 0 } }],
    'placement.container_instance counts from 1'],
  [['item_missing'], 'an event is a JSON object'],
  [[{ sequence: 1, type: 'container_substituted', container_type: '', replacement: { id: 'b' } }], 'container_type is a non-empty string'],
  [[{ sequence: 1, type: 'container_substituted', container_type: 'box', replacement: 'b' }], 'a replacement is a container object'],
  [[{ sequence: 1, type: 'placement_locked', placement: 'box#1' }], 'a placement is a fixed-placement object'],
  [[{ sequence: 1, type: 'placement_locked', placement: { ...locked().placement, item_id: 'cube#1' } }],
    'a placement does not carry ["item_id"]'],
  [[{ sequence: 1, type: 'placement_locked', placement: { ...locked().placement, position: [0, 0, 0] } }],
    'placement.position is a point object'],
];

MALFORMED_EVENTS.forEach(([events, message], index) => {
  test(`a malformed event is refused (${index}): ${message}`, () => {
    const root = rootRevision(cubeRequest());
    refused(() => deriveRevision(root, artifactFor(root.request), events), 'invalid_event', message);
  });
});

test('an artifact built from another request is refused', () => {
  const root = rootRevision(cubeRequest());
  const other = cubeRequest();
  other.items[0].quantity = 3;
  refused(() => deriveRevision(root, artifactFor(other), [locked()]), 'invalid_artifact',
    "the artifact was built from a different request than the parent's");
});

test('a parent that is not a revision is refused', () => {
  refused(() => deriveRevision(cubeRequest(), artifactFor(cubeRequest()), [locked()]), 'invalid_revision',
    'not a packvium-plan-revision/v1 document');
});

for (const [parent, message] of [
  [{ format: FORMAT, revision: -1, request: {}, events: [] }, 'revision is a non-negative integer'],
  [{ format: FORMAT, revision: 0, request: [], events: [] }, 'a revision carries its request'],
  [{ format: FORMAT, revision: 0, request: {}, events: {} }, 'a revision carries its events'],
  [{ format: FORMAT, revision: 2, request: cubeRequest(), events: [] }, 'only the root revision records no events'],
]) {
  test(`a malformed parent is refused: ${message}`, () => {
    refused(() => deriveRevision(parent, artifactFor(cubeRequest()), [locked()]), 'invalid_revision', message);
  });
}

for (const [artifact, message] of [
  [{ format: 'packvium-execution-plan/v1' }, 'not a packvium-operational-artifact/v1 document'],
  [{ format: 'packvium-operational-artifact/v1', provenance: { request: {} } }, 'the artifact carries no provenance.replay'],
]) {
  test(`a malformed artifact is refused: ${message}`, () => {
    refused(() => deriveRevision(rootRevision(cubeRequest()), artifact, [locked()]), 'invalid_artifact', message);
  });
}

test('a root needs a request object with a canonical spelling', () => {
  refused(() => rootRevision([]), 'invalid_revision', 'a request is a JSON object');
  refused(() => rootRevision({ items: [], containers: [], configuration: { seed: 2 ** 60 } }), 'number_out_of_range');
});

test('a plan that stopped on time is marked in the chain', () => {
  const root = rootRevision(cubeRequest());
  const artifact = artifactFor(root.request);
  artifact.provenance.solver.time_limit_reached = true;
  artifact.provenance.replay = { level: 'not_guaranteed', because: 'provenance.solver.time_limit_reached' };
  assert.equal(deriveRevision(root, artifact, [locked()]).approved.replay.level, 'not_guaranteed');
});

test('an intact chain verifies clean', () => {
  const [revisions, artifacts] = chain();
  assert.deepEqual(verifyRevisionChain(revisions, artifacts), []);
});

test('reordered events are caught', () => {
  const [revisions] = chain();
  const { events } = revisions[1];
  [events[0], events[1]] = [events[1], events[0]];
  assert.ok(codes(revisions).has('sequence_gap'));
});

test('a missing event is caught', () => {
  const [revisions] = chain();
  revisions[1].events.splice(1, 1);
  const found = codes(revisions);
  assert.ok(found.has('sequence_gap') && found.has('request_mismatch'));
});

test('an altered event is caught', () => {
  const [revisions] = chain();
  revisions[1].events[1].quantity = 2;
  assert.deepEqual(verifyRevisionChain(revisions)[0], { code: 'request_mismatch', revision: 1,
    detail: "the request is not what the parent's request and these events derive" });
});

test('an altered request breaks the link to the next revision', () => {
  const [revisions] = chain();
  revisions[1].request.items[0].quantity = 9;
  const found = codes(revisions);
  assert.ok(found.has('request_mismatch') && found.has('parent_mismatch'));
});

test('a dropped revision is caught', () => {
  const [revisions] = chain();
  revisions.splice(1, 1);
  const issues = verifyRevisionChain(revisions);
  assert.deepEqual(issues.map((entry) => entry.code).slice(0, 2), ['revision_number', 'parent_mismatch']);
  assert.equal(issues[0].detail, 'revision 2 at position 1');
  assert.ok(codes(revisions).has('sequence_gap'));
});

test('a substituted artifact is caught', () => {
  const [revisions, artifacts] = chain();
  const swapped = copy(artifacts);
  swapped[2] = artifacts[1];
  assert.ok(codes(revisions, swapped).has('artifact_mismatch'));
});

test('a chain that is not made of revisions stops the audit', () => {
  const [revisions] = chain();
  revisions[1] = { format: 'something-else' };
  assert.deepEqual(verifyRevisionChain(revisions),
    [{ code: 'invalid_revision', revision: 1, detail: 'not a packvium-plan-revision/v1 document' }]);
});

test('an item without a quantity counts as one', () => {
  const request = cubeRequest();
  delete request.items[1].quantity;
  const derived = applyEvents(request, [{ sequence: 1, type: 'item_missing', item_type: 'slab', quantity: 1 }]);
  assert.deepEqual(derived.items.map((item) => item.id), ['cube']);
});

test('a request whose entries are not objects is refused', () => {
  const request = cubeRequest();
  request.items = ['cube'];
  refused(() => applyEvents(request, [{ sequence: 1, type: 'item_missing', item_type: 'cube', quantity: 1 }]),
    'invalid_revision', 'request.items is a list of objects');
});

test('a root with events and a revision without them are caught', () => {
  const [revisions] = chain();
  revisions[0].events = [locked()];
  revisions[2].events = [];
  const gaps = verifyRevisionChain(revisions).filter((entry) => entry.code === 'sequence_gap')
    .map((entry) => [entry.code, entry.revision, entry.detail]);
  assert.deepEqual(gaps.slice(0, 2), [['sequence_gap', 0, 'the root revision records no events'],
    ['sequence_gap', 1, 'event 1 where 2 was next']]);
  assert.ok(gaps.some(([, revision, detail]) => revision === 2 && detail === 'a revision records at least one event'));
});

test('events that no longer apply are a request mismatch', () => {
  const [revisions] = chain();
  revisions[1].events[1].item_type = 'pallet';
  assert.deepEqual(verifyRevisionChain(revisions).find((entry) => entry.code === 'request_mismatch'),
    { code: 'request_mismatch', revision: 1, detail: 'the events do not apply: the request has no item "pallet"' });
});

test('an artifact for another request or with another replay is caught', () => {
  const [revisions, artifacts] = chain();
  const tampered = copy(artifacts);
  tampered[1].provenance.replay = { level: 'not_guaranteed', because: 'provenance.solver' };
  revisions[1].approved.artifact = documentDigest(tampered[1]);
  assert.deepEqual(verifyRevisionChain(revisions.slice(0, 2), tampered.slice(0, 2)),
    [{ code: 'artifact_mismatch', revision: 1, detail: "approved.replay is not the artifact's provenance.replay" }]);
  tampered[1].provenance.request = { items: [] };
  revisions[1].approved.artifact = documentDigest(tampered[1]);
  assert.deepEqual(verifyRevisionChain(revisions.slice(0, 2), tampered.slice(0, 2)),
    [{ code: 'artifact_mismatch', revision: 1, detail: "the artifact was built from a different request than the parent's" }]);
});

// ------------------------------------------------------------- malformed input, never a crash

test('a request key named __proto__ stays an ordinary key', () => {
  const request = JSON.parse('{"metadata":{"__proto__":{"x":1}},"items":[],"containers":[]}');
  const root = rootRevision(request);
  assert.equal(Object.getPrototypeOf(root.request.metadata), Object.prototype);
  assert.match(canonicalRevisionJson(root), /"metadata":\{"__proto__":\{"x":1\}\}/);
});

for (const [name, events, message] of [
  ['a type that is not a name', [{ ...locked(), type: ['placement_locked'] }], 'unknown event type ["placement_locked"]'],
  ['a type with no spelling', [{ ...locked(), type: '\uD800' }], 'unknown event type an unspellable value'],
  ['a missing type', [{ sequence: 1 }], 'unknown event type null'],
  ['a sequence beyond 2^53 - 1', [locked({ sequence: 2 ** 53 })], 'event sequence an out-of-range number does not continue the chain at 1'],
  ['a text sequence', [locked({ sequence: '1' })], 'event sequence "1" does not continue the chain at 1'],
  ['an extra axis', [{ ...locked(), placement: { ...locked().placement, position: { w: '5' } } }],
    'placement.position cannot carry ["w"]'],
  ['a boolean axis', [{ ...locked(), placement: { ...locked().placement, position: { x: true } } }],
    'placement.position.x is a measure'],
  ['a null instance', [{ ...locked(), placement: { ...locked().placement, container_instance: null } }],
    'placement.container_instance counts from 1'],
  ['unknown keys in code-point order', [{ ...locked(), '\u{1F600}': 1, '｡': 2 }],
    'placement_locked does not carry ["｡","\u{1F600}"]'],
]) {
  test(`a malformed event is refused: ${name}`, () => {
    const root = rootRevision(cubeRequest());
    refused(() => deriveRevision(root, artifactFor(root.request), events), 'invalid_event', message);
  });
}

test('a parent whose events do not each carry an integer sequence is refused', () => {
  const [[, first]] = chain();
  for (const edit of [(e) => { e[0].sequence = '1'; }, (e) => { e[0].sequence = true; },
    (e) => { delete e[0].sequence; }, (e) => { e[0] = 5; }]) {
    const broken = copy(first);
    edit(broken.events);
    refused(() => deriveRevision(broken, artifactFor(first.request), [locked({ sequence: 3 })]), 'invalid_revision',
      "a revision's events each carry an integer sequence");
  }
});

test('a request item quantity must be an integer when an item goes missing', () => {
  const missing = { sequence: 1, type: 'item_missing', item_type: 'slab', quantity: 1 };
  for (const quantity of ['3', 2.5, null, true]) {
    const request = cubeRequest();
    request.items[1].quantity = quantity;
    refused(() => applyEvents(request, [missing]), 'invalid_revision', 'request.items[1].quantity is an integer');
  }
});

test('a null fixed_placements is none, and anything else not a list of objects is refused', () => {
  const lock = locked();
  const missing = { sequence: 1, type: 'item_missing', item_type: 'cube', quantity: 1 };
  const request = { ...cubeRequest(), fixed_placements: null };
  assert.deepEqual(applyEvents(request, [lock]).fixed_placements, [lock.placement]);
  assert.equal(applyEvents(request, [missing]).fixed_placements, null);
  for (const value of [{ k: 1 }, [5], 'x']) {
    for (const event of [lock, missing]) {
      refused(() => applyEvents({ ...cubeRequest(), fixed_placements: value }, [event]), 'invalid_revision',
        'request.fixed_placements is a list of objects');
    }
  }
});

test('apply refuses a request or event list that is not JSON of the right kind', () => {
  refused(() => applyEvents([], [locked()]), 'invalid_revision', 'a request is a JSON object');
  refused(() => applyEvents(cubeRequest(), locked()), 'invalid_event', 'events are a JSON array');
});

test('apply refuses an event whose sequence is not an integer', () => {
  const missing = { type: 'item_missing', item_type: 'cube', quantity: 1 };
  for (const [sequence, spelled] of [[undefined, 'null'], ['1', '"1"'], [true, 'true'], [1.5, '1.5']]) {
    const event = sequence === undefined ? missing : { ...missing, sequence };
    refused(() => applyEvents(cubeRequest(), [event]), 'invalid_event', `event sequence ${spelled} is not an integer`);
  }
});

test('an audit refuses a chain or an artifact list that is not an array', () => {
  const [revisions, artifacts] = chain();
  refused(() => verifyRevisionChain({ 0: revisions[0] }), 'invalid_revision', 'a chain is a JSON array');
  refused(() => verifyRevisionChain(revisions, { 1: artifacts[1] }), 'invalid_artifact', 'artifacts is a JSON array');
});

test('an artifact that is not an object, or has no canonical form, is a mismatch', () => {
  const [revisions, artifacts] = chain();
  const unspellable = copy(artifacts[1]);
  unspellable.provenance.solver = { big: 2 ** 60 };
  for (const artifact of ['x', 5, unspellable]) {
    assert.deepEqual(verifyRevisionChain(revisions, [null, artifact, artifacts[2]]),
      [{ code: 'artifact_mismatch', revision: 1, detail: "the artifact's digest is not the one this revision approved" }]);
  }
});

test('an audited event without an integer sequence stops the audit there', () => {
  const [revisions] = chain();
  revisions[1].events[0].sequence = true;
  assert.deepEqual(verifyRevisionChain(revisions),
    [{ code: 'invalid_revision', revision: 1, detail: "a revision's events each carry an integer sequence" }]);
});

test('a parent that is not a digest is quoted as JSON', () => {
  const [revisions] = chain();
  revisions[0].parent = 5;
  assert.deepEqual(verifyRevisionChain(revisions.slice(0, 1)),
    [{ code: 'parent_mismatch', revision: 0, detail: 'parent 5, expected null' }]);
});
