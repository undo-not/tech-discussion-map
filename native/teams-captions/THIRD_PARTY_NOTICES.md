# Third-party notices

TechMap Live does not commit Tesseract, Leptonica, Windows OCR binaries, or traineddata to this repository. The dedicated GitHub Actions workflow may create a seven-day ephemeral, provenance-attested runtime artifact from pinned upstream sources for local installation.

The optional local OCR runtime executes an attested or separately approved Tesseract 5.5.3 distribution and `jpn` / `eng` traineddata after local SHA-256 verification. Generated artifacts include the upstream license texts for Tesseract, tessdata, Leptonica, and statically linked vcpkg dependencies.

- Tesseract OCR: Apache License 2.0 — https://github.com/tesseract-ocr/tesseract
- Leptonica: BSD 2-Clause License — http://www.leptonica.org/about-the-license.html
- tessdata: Apache License 2.0 — https://github.com/tesseract-ocr/tessdata

The license files included by the attested or user-supplied distribution remain authoritative for that installed copy.
