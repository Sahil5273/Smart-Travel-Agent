/**
 * Generates Smart-Travel-Agent-Framework.pdf from the markdown source.
 * Run: node docs/generate-pdf.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const INPUT = path.join(__dirname, 'Smart-Travel-Agent-Framework.md');
const OUTPUT = path.join(__dirname, 'Smart-Travel-Agent-Framework.pdf');

const PAGE_MARGIN = 50;
const CONTENT_WIDTH = 512; // letter width 612 - 2*50

function writePdf() {
  const md = fs.readFileSync(INPUT, 'utf8');
  const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'LETTER', bufferPages: true });
  const stream = fs.createWriteStream(OUTPUT);
  doc.pipe(stream);

  let pageCount = 0;
  doc.on('pageAdded', () => {
    pageCount += 1;
  });

  // Cover block
  doc.fontSize(22).font('Helvetica-Bold').text('Smart Travel Agent', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(13).font('Helvetica').fillColor('#444444')
    .text('Full Framework Documentation', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666666')
    .text('MERN-style · React + Express + Firestore + Gemini', { align: 'center' });
  doc.moveDown(1.5);
  doc.fillColor('#000000');

  let inCode = false;

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd();

    // Skip duplicate title at top of md
    if (line === '# Smart Travel Agent — Full Framework Documentation') continue;
    if (line.startsWith('**Project:**') || line.startsWith('**Stack:**') || line.startsWith('**Date:**')) {
      doc.fontSize(9).font('Helvetica').fillColor('#555555').text(line.replace(/\*\*/g, ''));
      continue;
    }
    if (line === '---') {
      doc.moveDown(0.4);
      doc.strokeColor('#cccccc').moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).stroke();
      doc.moveDown(0.6);
      continue;
    }

    if (line.startsWith('```')) {
      inCode = !inCode;
      if (inCode) doc.moveDown(0.2);
      continue;
    }

    if (inCode) {
      ensureSpace(doc, 14);
      doc.fontSize(8).font('Courier').fillColor('#1a1a1a')
        .text(line || ' ', { width: CONTENT_WIDTH });
      continue;
    }

    if (line.startsWith('# ')) {
      doc.moveDown(0.6);
      ensureSpace(doc, 28);
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#1a365d').text(line.slice(2));
      doc.moveDown(0.3);
      continue;
    }
    if (line.startsWith('## ')) {
      doc.moveDown(0.5);
      ensureSpace(doc, 22);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#2c5282').text(line.slice(3));
      doc.moveDown(0.2);
      continue;
    }
    if (line.startsWith('### ')) {
      doc.moveDown(0.3);
      ensureSpace(doc, 18);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#2d3748').text(line.slice(4));
      doc.moveDown(0.15);
      continue;
    }

    if (line.startsWith('|')) {
      ensureSpace(doc, 14);
      doc.fontSize(8.5).font('Helvetica').fillColor('#000000')
        .text(line, { width: CONTENT_WIDTH });
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      ensureSpace(doc, 14);
      const text = line.slice(2).replace(/\*\*(.*?)\*\*/g, '$1').replace(/`(.*?)`/g, '$1');
      doc.fontSize(10).font('Helvetica').fillColor('#000000')
        .text('•  ' + text, { width: CONTENT_WIDTH, indent: 10 });
      continue;
    }

    if (line.startsWith('> ')) {
      ensureSpace(doc, 14);
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#4a5568')
        .text(line.slice(2).replace(/\*/g, ''), { width: CONTENT_WIDTH, indent: 12 });
      continue;
    }

    if (line === '') {
      doc.moveDown(0.25);
      continue;
    }

    ensureSpace(doc, 14);
    const text = line
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/^#+\s*/, '');
    doc.fontSize(10).font('Helvetica').fillColor('#000000')
      .text(text, { width: CONTENT_WIDTH });
  }

  // Footers — flush buffer then stamp each page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor('#999999').font('Helvetica')
      .text(
        `Smart Travel Agent Framework · Page ${i + 1} of ${range.count}`,
        PAGE_MARGIN,
        doc.page.height - 35,
        { align: 'center', width: CONTENT_WIDTH }
      );
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(OUTPUT));
    stream.on('error', reject);
  });
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - PAGE_MARGIN - 30) {
    doc.addPage();
  }
}

writePdf()
  .then((out) => {
    console.log('PDF created:', out);
  })
  .catch((err) => {
    console.error('PDF generation failed:', err);
    process.exit(1);
  });
