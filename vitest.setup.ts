// The reflect polyfill, before any test file is evaluated.
//
// Both servers wire themselves with tsyringe, whose `@inject()` writes its
// metadata at class-definition time — so a test that imports a decorated module
// before something imported "reflect-metadata" dies on the import, with an error
// about an entry point it does not have. The entry points do import it (see
// either index.ts); a test file's imports are in whatever order it needs, which
// is why this is a setup file and not a convention to remember.

import "reflect-metadata";
