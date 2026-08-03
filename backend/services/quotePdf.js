/**
 * Enterprise A4 PDF generator for quotations/invoices.
 * Layout mirrors frontend DocumentPreview for print parity.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const UPLOADS = path.join(__dirname, '..', 'uploads');

const ACCENTS = {
  modern: '#0284c7',
  minimal: '#334155',
  medical: '#0f766e',
  construction: '#b45309',
  manufacturing: '#475569',
  real_estate: '#6d28d9',
  corporate: '#0f172a',
};

function money(n, currency = 'MYR') {
  return `${currency} ${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusLabel(status) {
  return String(status || 'draft').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function lineAmount(it) {
  const qty = Number(it.quantity) || 0;
  const unit = Number(it.unitPrice) || 0;
  const disc = Number(it.discount) || 0;
  return Math.max(0, qty * unit - disc);
}

function resolveLocalImage(urlOrPath) {
  if (!urlOrPath || typeof urlOrPath !== 'string') return null;
  if (urlOrPath.startsWith('/uploads/')) {
    const p = path.join(UPLOADS, path.basename(urlOrPath));
    return fs.existsSync(p) ? p : null;
  }
  if (fs.existsSync(urlOrPath)) return urlOrPath;
  return null;
}

function wrapText(doc, text, width, fontSize = 9) {
  doc.fontSize(fontSize);
  return doc.heightOfString(String(text || ''), { width });
}

/**
 * @returns {Promise<{ absolutePath: string, urlPath: string, filename: string }>}
 */
function generateDocumentPdf(doc) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
      const filename = `${doc.id}.pdf`;
      const absolutePath = path.join(UPLOADS, filename);

      const company = doc.company || {};
      const customer = doc.customer || {};
      const items = Array.isArray(doc.lineItems) ? doc.lineItems : [];
      const currency = doc.currency || 'MYR';
      const template = doc.template || 'corporate';
      const accent = ACCENTS[template] || ACCENTS.corporate;
      const isInvoice = doc.docType === 'invoice';
      const title = isInvoice ? 'INVOICE' : 'QUOTATION';
      const issueDate = doc.createdAt || new Date().toISOString();
      const dueOrValid = isInvoice ? doc.dueDate : doc.validUntil;
      const dueLabel = isInvoice ? 'Due date' : 'Valid until';
      const payUrl = company.paymentLink || company.meta?.paymentLink || doc.shareUrl || '';
      const bank = company.bankDetails || company.meta?.bankDetails || '';
      const taxId = company.taxId || company.registrationNumber || '';
      const companyName = company.companyName || company.name || 'Your Company';


      const pdf = new PDFDocument({
        size: 'A4',
        margins: { top: 42, bottom: 42, left: 42, right: 42 },
        info: {
          Title: `${title} ${doc.number || ''}`.trim(),
          Author: companyName,
          Creator: 'LeadFlow AI',
        },
      });

      const stream = fs.createWriteStream(absolutePath);
      pdf.pipe(stream);

      const pageW = pdf.page.width;
      const left = 42;
      const right = pageW - 42;
      const contentW = right - left;

      // Top accent bar
      pdf.rect(0, 0, pageW, 6).fill(accent);

      // Brand row
      let y = 28;
      const logoPath = resolveLocalImage(company.logoUrl);
      if (logoPath) {
        try {
          pdf.image(logoPath, left, y, { fit: [54, 54] });
        } catch {
          // ignore bad image
        }
      } else {
        pdf.roundedRect(left, y, 54, 54, 8).fill(accent);
        pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
          .text(String(companyName).slice(0, 1).toUpperCase(), left, y + 14, { width: 54, align: 'center' });
      }

      pdf.fillColor(accent).font('Helvetica-Bold').fontSize(18)
        .text(companyName, left + 66, y + 4, { width: contentW * 0.48 });
      if (company.headerText) {
        pdf.fillColor('#64748b').font('Helvetica').fontSize(9)
          .text(company.headerText, left + 66, y + 26, { width: contentW * 0.48 });
      }

      // Document title / meta (right)
      const metaX = left + contentW * 0.55;
      pdf.fillColor(accent).font('Helvetica-Bold').fontSize(22)
        .text(title, metaX, y, { width: contentW * 0.45, align: 'right' });

      const badge = statusLabel(doc.status);
      const badgeW = Math.min(110, pdf.widthOfString(badge) + 18);
      const badgeX = right - badgeW;
      pdf.roundedRect(badgeX, y + 28, badgeW, 16, 8).fill('#f1f5f9');
      pdf.fillColor('#334155').font('Helvetica-Bold').fontSize(8)
        .text(badge.toUpperCase(), badgeX, y + 32, { width: badgeW, align: 'center' });

      const metaRows = [
        ['Number', doc.number || 'Draft'],
        ['Issue date', fmtDate(issueDate)],
        [dueLabel, fmtDate(dueOrValid)],
        ['Currency', currency],
      ];
      let metaY = y + 52;
      for (const [k, v] of metaRows) {
        pdf.fillColor('#64748b').font('Helvetica').fontSize(8).text(k.toUpperCase(), metaX, metaY, { width: 80 });
        pdf.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9)
          .text(String(v), metaX + 70, metaY, { width: contentW * 0.45 - 70, align: 'right' });
        metaY += 14;
      }

      // Company contact under logo
      y = Math.max(y + 66, metaY + 6);
      const companyLines = [
        company.address,
        [company.city, company.country].filter(Boolean).join(', '),
        company.phone ? `Tel: ${company.phone}` : '',
        company.email || '',
        company.website || '',
        taxId ? `Tax / Reg: ${taxId}` : '',
      ].filter(Boolean);
      pdf.fillColor('#64748b').font('Helvetica').fontSize(8);
      for (const line of companyLines) {
        pdf.text(line, left, y, { width: contentW * 0.5 });
        y += 11;
      }

      y += 10;

      // From / Bill To cards
      const cardH = 88;
      const cardGap = 12;
      const cardW = (contentW - cardGap) / 2;

      pdf.roundedRect(left, y, cardW, cardH, 8).fillAndStroke('#f8fafc', '#e2e8f0');
      pdf.roundedRect(left + cardW + cardGap, y, cardW, cardH, 8).fill('#ffffff').stroke('#e2e8f0');
      pdf.rect(left + cardW + cardGap, y, 3, cardH).fill(accent);

      const drawParty = (x, label, name, lines) => {
        pdf.fillColor('#64748b').font('Helvetica-Bold').fontSize(8)
          .text(label.toUpperCase(), x + 12, y + 10, { width: cardW - 24 });
        pdf.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11)
          .text(name || '—', x + 12, y + 24, { width: cardW - 24 });
        pdf.fillColor('#64748b').font('Helvetica').fontSize(8);
        let ly = y + 40;
        for (const line of lines.filter(Boolean).slice(0, 3)) {
          pdf.text(String(line), x + 12, ly, { width: cardW - 24 });
          ly += 11;
        }
      };

      drawParty(left, 'From', companyName, [
        company.address,
        company.phone,
        company.email,
      ]);
      drawParty(left + cardW + cardGap, 'Bill to', customer.company || customer.name || 'Customer', [
        customer.name && customer.company ? customer.name : '',
        customer.address,
        customer.email || customer.phone,
      ]);

      y += cardH + 16;

      // Line items table
      const cols = [
        { key: 'item', label: '#', w: 28, align: 'left' },
        { key: 'desc', label: 'Description', w: 168, align: 'left' },
        { key: 'qty', label: 'Qty', w: 36, align: 'right' },
        { key: 'unit', label: 'Unit price', w: 72, align: 'right' },
        { key: 'disc', label: 'Discount', w: 60, align: 'right' },
        { key: 'tax', label: 'Tax', w: 56, align: 'right' },
        { key: 'total', label: 'Total', w: contentW - 28 - 168 - 36 - 72 - 60 - 56, align: 'right' },
      ];

      const drawTableHeader = () => {
        pdf.rect(left, y, contentW, 22).fill(accent);
        let x = left;
        pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7);
        for (const c of cols) {
          pdf.text(c.label.toUpperCase(), x + 4, y + 7, { width: c.w - 8, align: c.align });
          x += c.w;
        }
        y += 22;
      };

      drawTableHeader();

      const ensureSpace = (need) => {
        if (y + need > pdf.page.height - 50) {
          pdf.addPage();
          pdf.rect(0, 0, pageW, 6).fill(accent);
          y = 28;
          drawTableHeader();
        }
      };

      const taxPct = Number(doc.taxPct) || 0;
      if (items.length === 0) {
        ensureSpace(28);
        pdf.fillColor('#64748b').font('Helvetica').fontSize(9)
          .text('No line items yet', left, y + 10, { width: contentW, align: 'center' });
        y += 36;
      } else {
        items.forEach((it, i) => {
          const amt = lineAmount(it);
          const lineTax = taxPct > 0 ? Math.round(amt * (taxPct / 100) * 100) / 100 : 0;
          const desc = String(it.description || '—');
          const descH = Math.max(28, wrapText(pdf, desc, cols[1].w - 8, 9) + 10);
          ensureSpace(descH + 4);

          if (i % 2 === 1) {
            pdf.rect(left, y, contentW, descH).fill('#f8fafc');
          }
          pdf.strokeColor('#e2e8f0').moveTo(left, y + descH).lineTo(right, y + descH).stroke();

          const row = [
            String(i + 1).padStart(2, '0'),
            desc,
            String(it.quantity ?? 0),
            money(it.unitPrice || 0, currency),
            money(it.discount || 0, currency),
            money(lineTax, currency),
            money(amt, currency),
          ];
          let x = left;
          row.forEach((val, idx) => {
            const c = cols[idx];
            const isStrong = idx === 6;
            pdf.fillColor('#0f172a')
              .font(isStrong || idx === 1 ? 'Helvetica-Bold' : 'Helvetica')
              .fontSize(idx === 1 ? 9 : 8)
              .text(val, x + 4, y + 8, { width: c.w - 8, align: c.align });
            x += c.w;
          });
          y += descH;
        });
      }

      y += 14;
      ensureSpace(160);

      // Lower: info cards + summary
      const summaryW = 200;
      const leftColW = contentW - summaryW - 14;
      const infoStartY = y;

      const infoBlocks = [];
      if (doc.paymentTerms) infoBlocks.push(['Payment terms', doc.paymentTerms]);
      if (doc.notes) infoBlocks.push(['Notes', doc.notes]);
      if (doc.terms) infoBlocks.push(['Terms & conditions', doc.terms]);
      if (bank) infoBlocks.push(['Bank details', typeof bank === 'string' ? bank : JSON.stringify(bank)]);
      if (payUrl) infoBlocks.push(['Payment link', payUrl]);

      let infoY = y;
      for (const [label, body] of infoBlocks) {
        const bodyH = wrapText(pdf, body, leftColW - 16, 9) + 28;
        ensureSpace(bodyH + 8);
        pdf.roundedRect(left, infoY, leftColW, bodyH, 6).stroke('#e2e8f0');
        pdf.fillColor('#64748b').font('Helvetica-Bold').fontSize(7)
          .text(label.toUpperCase(), left + 8, infoY + 8, { width: leftColW - 16 });
        pdf.fillColor('#0f172a').font('Helvetica').fontSize(9)
          .text(String(body), left + 8, infoY + 20, { width: leftColW - 16 });
        infoY += bodyH + 8;
      }

      // Summary box
      const summaryRows = [
        ['Subtotal', money(doc.subtotal || 0, currency)],
        [
          `Discount${doc.discountPct ? ` (${doc.discountPct}%)` : ''}`,
          `-${money(doc.discountAmount || 0, currency)}`,
        ],
        [
          `Tax${doc.taxPct != null ? ` (${doc.taxPct}%)` : ''}`,
          money(doc.taxAmount || 0, currency),
        ],
        ['Shipping', money(doc.shipping || 0, currency)],
      ];
      if (isInvoice && Number(doc.amountPaid || 0) > 0) {
        summaryRows.push(['Amount paid', money(doc.amountPaid || 0, currency)]);
        summaryRows.push([
          'Balance due',
          money(Math.max(0, Number(doc.total || 0) - Number(doc.amountPaid || 0)), currency),
        ]);
      }

      const summaryH = 20 + summaryRows.length * 18 + 36;
      const summaryX = right - summaryW;
      pdf.roundedRect(summaryX, infoStartY, summaryW, summaryH, 10).fillAndStroke('#f8fafc', '#e2e8f0');
      let sy = infoStartY + 12;
      for (const [k, v] of summaryRows) {
        pdf.fillColor('#64748b').font('Helvetica').fontSize(9).text(k, summaryX + 12, sy, { width: 90 });
        pdf.fillColor('#0f172a').font('Helvetica').fontSize(9)
          .text(v, summaryX + 12, sy, { width: summaryW - 24, align: 'right' });
        sy += 18;
      }
      pdf.roundedRect(summaryX + 8, sy + 2, summaryW - 16, 28, 6).fill(accent);
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
        .text('Grand total', summaryX + 16, sy + 10, { width: 80 });
      pdf.text(money(doc.total || 0, currency), summaryX + 16, sy + 10, {
        width: summaryW - 32,
        align: 'right',
      });

      y = Math.max(infoY, infoStartY + summaryH) + 18;

      // Footer
      ensureSpace(30);
      pdf.strokeColor('#e2e8f0').moveTo(left, y).lineTo(right, y).stroke();
      pdf.fillColor('#64748b').font('Helvetica').fontSize(8)
        .text(company.footerText || 'Thank you for your business.', left, y + 10, { width: contentW * 0.65 });
      pdf.font('Helvetica-Bold').text(`${doc.number || 'Draft'} · ${title}`, left, y + 10, {
        width: contentW,
        align: 'right',
      });

      pdf.end();
      stream.on('finish', () => {
        resolve({ absolutePath, urlPath: `/uploads/${filename}`, filename });
      });
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateDocumentPdf };
