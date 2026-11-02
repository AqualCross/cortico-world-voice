# Third-party components — package.json, tools/build.mjs, assets/manifest.json

The extension's own code is covered by [extension-MIT.txt](extension-MIT.txt). The components below retain their respective licenses.

| Component | Use | License and attribution |
|---|---|---|
| [abcjs 6.7.2](https://github.com/paulrosen/abcjs/tree/2e399a65fdf12a0dfaf80a0837cc0f182c67fb37) | ABC parsing, MIDI generation and SVG notation; included in the browser bundle | MIT, copyright 2009–2026 Paul Rosen and Gregory Dyke. Full text: [licenses/abcjs-MIT.txt](abcjs-MIT.txt). |
| sprintf() for JavaScript v0.4, embedded in abcjs | Formatting SVG drawing data | BSD 3-Clause, copyright 2007–present Alexandru Mărășteanu. The original notice is reproduced in [licenses/sprintf-BSD-3-Clause.txt](sprintf-BSD-3-Clause.txt). |
| [spessasynth_core 4.3.22](https://github.com/spessasus/spessasynth_core/tree/99f294d997dea0f2691738c97586c6a3d289fe7d) | Headless SoundFont rendering; installed as an npm dependency | Apache-2.0, copyright 2026 Spessasus. Full text: [licenses/Apache-2.0.txt](Apache-2.0.txt). |
| [fflate, embedded in spessasynth_core](https://github.com/spessasus/spessasynth_core/tree/99f294d997dea0f2691738c97586c6a3d289fe7d/src/externals/fflate) | DEFLATE decompression | MIT, copyright 2023 Arjun Barrett. The embedded copy does not declare a version; its upstream notice is reproduced in [licenses/fflate-MIT.txt](fflate-MIT.txt). |
| [stb-vorbis 0.0.7](https://github.com/spessasus/stb-vorbis) | spessasynth_core dependency for SF3 decoding | Apache-2.0. Full text: [licenses/Apache-2.0.txt](Apache-2.0.txt). |
| stb_vorbis.c, embedded in stb-vorbis | WebAssembly Vorbis decoder | Sean Barrett; MIT or public-domain dedication, at the recipient's choice. The original text is reproduced in [licenses/stb-vorbis-C.txt](stb-vorbis-C.txt). |
| [esbuild 0.28.2](https://github.com/evanw/esbuild) | Build tool; not included in the runtime package | MIT, copyright 2020 Evan Wallace. Its license accompanies the development dependency. |

The abcjs and sprintf notices are also included in `dist/webui.js`. The Apache license accompanies both installed npm dependencies. Neither installed package contains a separate NOTICE file.

This integration resolves stb-vorbis 0.0.7; its Apache license is checked against the distributed license by the migrated tests. spessasynth_core declares it as `latest`, so a fresh downstream installation can resolve a different version; the extension's development lockfile does not pin downstream installations.

## GeneralUser GS 2.0.3

[GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) is by S. Christian Collins and uses its own License v2.0. The extension package contains no SoundFont samples. Users may download the pinned, unmodified upstream file from the Instruments panel. The complete license is in [assets/GeneralUser-GS-LICENSE.txt](../../assets/music-abc/GeneralUser-GS-LICENSE.txt); the source commit and SHA-256 are recorded in [assets/manifest.json](../../assets/music-abc/manifest.json).

The license permits private and commercial music creation and inclusion in software projects. The author also states that some samples came from other freely available SoundFont banks and that the original provenance of every sample cannot be fully established. This extension preserves and discloses that qualification; it has not independently verified the ownership and authorization of every contained sample. The complete upstream statement is retained in [assets/GeneralUser-GS-LICENSE.txt](../../assets/music-abc/GeneralUser-GS-LICENSE.txt).

GeneralUser GS is downloaded only after the user selects Get GeneralUser GS. Its original license is copied alongside the downloaded file in the extension data directory. The provenance qualification is also displayed at the download entry. User-imported SF2/SF3 files remain subject to their own licenses.
