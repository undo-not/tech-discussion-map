# Third-party notices

TechMap Live does not bundle Tesseract, Leptonica, Windows OCR binaries, or traineddata in this repository or its CI artifacts.

The optional local OCR runtime is designed to execute a separately installed Tesseract 5.5.3 distribution and `jpn` / `eng` traineddata after local SHA-256 verification.

- Tesseract OCR: Apache License 2.0 — https://github.com/tesseract-ocr/tesseract
- Leptonica: BSD 2-Clause License — http://www.leptonica.org/about-the-license.html
- tessdata: Apache License 2.0 — https://github.com/tesseract-ocr/tessdata

The license files included by the user-supplied distribution remain authoritative for that installed copy.
