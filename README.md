# @packvium/engine

Deterministic 3D cartonization for Node.js. It uses the optional native engine when
available and automatically falls back to the bundled JavaScript implementation.

## Install

```bash
npm install @packvium/engine
```

Node.js 16 or later is required. Use a currently supported Node.js release in
production.

## Quick start

```js
import { backend, pack } from '@packvium/engine';

const result = pack({
  items: [{
    id: 'book', quantity: 4,
    dimensions: { length: '210', width: '140', height: '30' },
  }],
  containers: [{
    id: 'carton',
    inner_dimensions: { length: '400', width: '300', height: '250' },
  }],
});

console.log(backend());       // "rust" or "javascript"
console.log(result.status);   // "feasible"
console.log(result.containers);
```

## Features

- Exact, deterministic placement with no floating-point geometry decisions.
- Rotation, payload, stackability, support, clearance, obstacle and tag constraints.
- Multiple container types and clear explanations for unpacked items.
- JSON input/output through `pack()` or `packJson()`.
- Optional payload rebalancing with `rebalanceWeight()`.
- Loading and removal sequence helpers for already placed boxes.

The native addon is optional. `npm install` works on unsupported platforms too; call
`backend()` if your application needs to know which implementation handled a request.

## API and support

TypeScript declarations are included. See the package's `index.d.ts` for the complete
request and result types. Report security issues through [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
