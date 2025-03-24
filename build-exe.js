const exe = require('@angablue/exe');

const version = process.env.VERSION || '1.0.0';  // Default version

const build = exe({
  entry: 'server.js',
  out: 'dist/CaptionAI.exe',
  skipBundle: false,
  version: version,
  icon: 'public/favicon.ico',
  executionLevel: 'asInvoker',
  properties: {
    FileDescription: 'Fetch, translates, and downloads YouTube subtitles.',
    ProductName: 'CaptionAI',
    LegalCopyright: 'YeBeKhe',
    OriginalFilename: 'CaptionAI.exe'
  }
});

build.then(() => console.log('Build completed!')).catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
