/** What the port answers: a list of issues, or a refusal to judge. */

/** One way a result fails to be a sound answer to its request. */
export const issue = (code, detail) => ({ code, detail });

/**
 * Why the port cannot judge a pair of documents (docs/VALIDATION-CONTRACT.md).
 *
 * `contract` is the reference raising `MalformedResult` with the same message. `shape` is the
 * reference failing on the input some other way -- a missing key, a value of the wrong type --
 * where only the fact of the refusal is compared, so the message is this port's own.
 */
export class Refusal extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'Refusal';
    this.kind = kind;
  }
}

export const contract = (message) => new Refusal('contract', message);

export const shape = (message) => new Refusal('shape', message);
