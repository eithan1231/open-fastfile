// Globals three.js's glTF loader expects to find, for a process that has no
// browser. Imported for its side effect, before anything that loads a .glb.
//
// GLTFLoader's *texture* path reaches for `self` and `createImageBitmap`. The
// server never wants a texture — it reads geometry to collide against — but the
// loader decodes a file's images as part of building its materials, so it
// touches them anyway. Two stubs are cheaper and far more predictable than
// forking the loader, and a map's own collision.glb carries no textures at all.
//
// Anything beyond this is a mistake: if the server starts needing real browser
// APIs, the code wanting them belongs on the client.

const g = globalThis as Record<string, unknown>;

g.self ??= globalThis;
// A 1x1 stand-in. The pixels are never read; only the material holding it is,
// and the server throws that away with the rest of the appearance.
g.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
