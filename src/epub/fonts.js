import lexend300 from '@fontsource/lexend/files/lexend-latin-300-normal.woff2';
import lexend400 from '@fontsource/lexend/files/lexend-latin-400-normal.woff2';
import lexend500 from '@fontsource/lexend/files/lexend-latin-500-normal.woff2';
import lexend600 from '@fontsource/lexend/files/lexend-latin-600-normal.woff2';
import lexend700 from '@fontsource/lexend/files/lexend-latin-700-normal.woff2';
import atkinson400Normal from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2';
import atkinson400Italic from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff2';
import atkinson700Normal from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2';
import atkinson700Italic from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-italic.woff2';

const LATIN_RANGE = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

function face(family, source, weight, style = 'normal') {
  return `
    @font-face {
      font-family: "${family}";
      src: url("${source}") format("woff2");
      font-style: ${style};
      font-weight: ${weight};
      font-display: block;
      unicode-range: ${LATIN_RANGE};
    }
  `;
}

export const bundledFontFaces = [
  face('Lexend', lexend300, 300),
  face('Lexend', lexend400, 400),
  face('Lexend', lexend500, 500),
  face('Lexend', lexend600, 600),
  face('Lexend', lexend700, 700),
  face('Atkinson Hyperlegible', atkinson400Normal, 400),
  face('Atkinson Hyperlegible', atkinson400Italic, 400, 'italic'),
  face('Atkinson Hyperlegible', atkinson700Normal, 700),
  face('Atkinson Hyperlegible', atkinson700Italic, 700, 'italic'),
].join('\n');
