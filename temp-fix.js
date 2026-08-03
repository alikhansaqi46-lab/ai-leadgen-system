const fs = require('fs');
const file = 'C:/AI-LeadGen-system/frontend/src/features/scraper/ScraperPage.tsx';
let f = fs.readFileSync(file, 'utf8');

const oldTable = '<tr><th>Name</th><th>Phone</th><th>Website</th><th>City</th><th>Rating</th><th>Reviews</th></tr>';
const newTable = [
  '<tr>',
  '                    <th>Business Name</th>',
  '                    <th>Phone</th>',
  '                    <th>Email</th>',
  '                    <th>Website</th>',
  '                    <th>Full Address</th>',
  '                    <th>City</th>',
  '                    <th>Rating</th>',
  '                    <th>Reviews</th>',
  '                  </tr>'
].join('\n');

const oldRow = [
  '                    <tr key={l.id}>',
  "                      <td>{l.name || '—'}</td>",
  "                      <td>{l.phone && l.phone !== 'N/A' ? l.phone : '—'}</td>",
  '                      <td>',
  "                        {l.website && l.website !== 'N/A' ? (",
  '                          <a className="lf-link" href={l.website} target="_blank" rel="noreferrer">site</a>',
  "                        ) : '—'}",
  '                      </td>',
  "                      <td>{l.city || '—'}</td>",
  "                      <td>{l.rating ?? '—'}</td>",
  "                      <td>{l.reviews ?? '—'}</td>",
  '                    </tr>'
].join('\n');

const newRow = [
  '                    <tr key={l.id}>',
  "                      <td style={{ fontWeight: 600 }}>{l.name || '—'}</td>",
  "                      <td>{l.phone && l.phone !== 'N/A' ? l.phone : '—'}</td>",
  '                      <td>',
  '                        {l.email && l.email !== "N/A" ? (',
  '                          <a href={`mailto:${l.email}`} className="lf-contact-link">{l.email}</a>',
  '                        ) : (',
  '                          <span className="lf-contact-muted">—</span>',
  '                        )}',
  '                      </td>',
  '                      <td>',
  '                        {l.website && l.website !== "N/A" ? (',
  '                          <a className="lf-contact-link" href={l.website} target="_blank" rel="noreferrer">{l.website.replace(/^https?:\\/\\//, \'\').slice(0, 28)}{l.website.length > 31 ? \'\u2026\' : \'\'}</a>',
  '                        ) : (',
  '                          <span className="lf-contact-muted">—</span>',
  '                        )}',
  '                      </td>',
  '                      <td style={{ maxWidth: 280, whiteSpace: \'nowrap\', overflow: \'hidden\', textOverflow: \'ellipsis\' }} title={l.address || undefined}>',
  "                        <span className=\"lf-contact-text\">{l.address || '—'}</span>",
  '                      </td>',
  "                      <td><span className=\"lf-pill\">{l.city || '—'}</span></td>",
  "                      <td>{l.rating ? <span style={{ color: '#fbbf24', fontWeight: 700 }}>★ {l.rating}</span> : '—'}</td>",
  "                      <td>{l.reviews ? l.reviews.toLocaleString() : '—'}</td>",
  '                    </tr>'
].join('\n');

if (!f.includes(oldTable)) { console.log('oldTable not found'); process.exit(1); }
if (!f.includes(oldRow)) { console.log('oldRow not found'); process.exit(1); }

f = f.replace(oldTable, newTable);
f = f.replace(oldRow, newRow);
fs.writeFileSync(file, f);
console.log('table replaced');
