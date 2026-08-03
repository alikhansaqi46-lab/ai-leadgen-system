import {
  detectTextDirection,
  stripTagsForAnalysis,
} from './textDirection';

describe('textDirection', () => {
  it('detects English as LTR', () => {
    expect(detectTextDirection('Hello, thanks for your reply.')).toBe('ltr');
  });

  it('detects Urdu/Arabic script as RTL when dominant', () => {
    expect(detectTextDirection('آپ کا شکریہ')).toBe('rtl');
    expect(detectTextDirection('شکریہ')).toBe('rtl');
  });

  it('uses auto for mixed Urdu + English + numbers + currency', () => {
    const mixed = 'ASA Medicated Toothpaste کی قیمت 20 RM ہے۔';
    expect(detectTextDirection(mixed)).toBe('auto');
  });

  it('detects Hebrew as RTL', () => {
    expect(detectTextDirection('שלום')).toBe('rtl');
  });

  it('detects German as LTR', () => {
    expect(detectTextDirection('Guten Tag, wie geht es Ihnen?')).toBe('ltr');
  });

  it('detects Russian Cyrillic as LTR', () => {
    expect(detectTextDirection('Спасибо за ваш ответ')).toBe('ltr');
  });

  it('detects Hindi Devanagari as LTR', () => {
    expect(detectTextDirection('धन्यवाद')).toBe('ltr');
  });

  it('detects CJK as LTR (horizontal writing)', () => {
    expect(detectTextDirection('谢谢您的回复')).toBe('ltr');
    expect(detectTextDirection('ありがとうございます')).toBe('ltr');
    expect(detectTextDirection('감사합니다')).toBe('ltr');
  });

  it('stripTagsForAnalysis preserves readable text from HTML', () => {
    const plain = stripTagsForAnalysis('<p dir="rtl">کی <b>قیمت</b> 20 RM</p>');
    expect(plain).toContain('کی');
    expect(plain).toContain('20 RM');
  });
});
