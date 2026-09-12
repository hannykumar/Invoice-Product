# Other people's work used in this package

## Tabler Icons — the picture library (issue #147)

`src/marks-library.generated.ts` holds 1,871 line drawings copied from **Tabler Icons** v3.46.0,
a free and open set. A business searches these when it wants a mark of its trade on its bill.

The drawings are copied into this repository on purpose, by `tools/trade-marks/build-library.ts`,
so that a bill prints with no internet and a business's chosen mark never changes shape because a
library was upgraded. `@tabler/icons` is a development dependency, needed only to rebuild the file.

The licence is MIT, which allows the drawings to be used, changed and sold on, and requires this
notice to travel with them:

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Other companies' logos are **not** copied. The build script drops Tabler's whole `Brand` group,
because another company's mark has no business being printed on your bill. It also drops the screen
furniture (arrows, letters, numbers), the crossed-out "not available" variants, and the badged
repeats of the same drawing — a basket with a tick, a basket with a cog — which mean something on a
screen and nothing on a bill.
