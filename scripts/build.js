#!/usr/bin/env node
/**
 * Собирает единый dist/index.html (CSS и JS инлайнятся)
 * для простого деплоя одним файлом.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'css', 'styles.css');
const jsPath = path.join(root, 'js', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

html = html.replace(
  /<link\s+rel="stylesheet"\s+href="css\/styles\.css"\s*\/>/,
  `<style>\n${css}\n    </style>`
);

html = html.replace(
  /<script\s+src="js\/app\.js"><\/script>/,
  `<script>\n${js}\n    </script>`
);

fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, 'index.html');
fs.writeFileSync(outPath, html, 'utf8');

console.log(`Build OK → ${path.relative(root, outPath)} (${html.length} bytes)`);
