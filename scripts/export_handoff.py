"""Export the maintained handoff and queue as a portable PDF. Requires reportlab."""
from pathlib import Path
from datetime import datetime
from html import escape
import re
import reportlab
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output' / 'pdf' / 'JPXFORGE-CONTINUIDADE.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
# Embed the fonts bundled with ReportLab so rendering does not depend on local
# Helvetica substitutions. This works on Windows and Linux without extra fonts.
FONT_DIR = Path(reportlab.__file__).resolve().parent / 'fonts'
pdfmetrics.registerFont(TTFont('ForgeSans', str(FONT_DIR / 'Vera.ttf')))
pdfmetrics.registerFont(TTFont('ForgeSans-Bold', str(FONT_DIR / 'VeraBd.ttf')))
pdfmetrics.registerFontFamily('ForgeSans', normal='ForgeSans', bold='ForgeSans-Bold')
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodyForge', fontName='ForgeSans', fontSize=9.5, leading=14, spaceAfter=6, textColor=colors.HexColor('#243247'), splitLongWords=True))
styles.add(ParagraphStyle(name='TitleForge', fontName='ForgeSans-Bold', fontSize=22, leading=28, spaceAfter=16, textColor=colors.HexColor('#142B44')))
styles.add(ParagraphStyle(name='SectionForge', fontName='ForgeSans-Bold', fontSize=12, leading=17, spaceBefore=10, spaceAfter=6, textColor=colors.HexColor('#007F80'), keepWithNext=True))

def clean(text):
    text = escape(text.replace('—', '-').replace('–', '-').replace('→', '->').replace('`', ''))
    return re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)

story = []
sources = [ROOT / 'docs' / 'HANDOFF.md', ROOT / 'docs' / 'BACKLOG.md'] + sorted((ROOT / 'docs').glob('*-HANDOFF.md'))
for index, source in enumerate(sources):
    if index:
        story.append(PageBreak())
    for block in source.read_text(encoding='utf-8-sig').split('\n\n'):
        block = block.strip()
        if not block:
            continue
        if block.startswith('# '):
            story.append(Paragraph(clean(block[2:]), styles['TitleForge']))
        elif block.startswith('## '):
            story.append(Paragraph(clean(block[3:]), styles['SectionForge']))
        else:
            story.append(Paragraph(clean(block).replace('\n', '<br/>'), styles['BodyForge']))

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#CAD5DD'))
    canvas.line(18*mm, 17*mm, 192*mm, 17*mm)
    canvas.setFont('ForgeSans', 8)
    canvas.setFillColor(colors.HexColor('#617080'))
    canvas.drawString(18*mm, 12*mm, 'JPXFORGE | Continuidade entre modelos | ' + datetime.now().strftime('%Y-%m-%d'))
    canvas.drawRightString(192*mm, 12*mm, str(doc.page))
    canvas.restoreState()

SimpleDocTemplate(str(OUT), pagesize=(210*mm, 297*mm), rightMargin=18*mm, leftMargin=18*mm, topMargin=18*mm, bottomMargin=23*mm, title='JPXFORGE - Continuidade', author='JPXFORGE / Codex').build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
