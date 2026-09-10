"""Export the maintained handoff and queue as a portable PDF. Requires reportlab."""
from pathlib import Path
from datetime import datetime
from html import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output' / 'pdf' / 'JPXFORGE-CONTINUIDADE.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodyForge', fontName='Helvetica', fontSize=10, leading=15, spaceAfter=8, textColor=colors.HexColor('#243247'), wordWrap='CJK'))
styles.add(ParagraphStyle(name='TitleForge', fontName='Helvetica-Bold', fontSize=24, leading=29, spaceAfter=20, textColor=colors.HexColor('#142B44')))
styles.add(ParagraphStyle(name='SectionForge', fontName='Helvetica-Bold', fontSize=13, leading=18, spaceBefore=12, spaceAfter=7, textColor=colors.HexColor('#007F80'), keepWithNext=True))

def clean(text):
    return escape(text.replace('—', '-').replace('–', '-').replace('→', '->').replace('`', ''))

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
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(colors.HexColor('#617080'))
    canvas.drawString(18*mm, 12*mm, 'JPXFORGE | Continuidade entre modelos | ' + datetime.now().strftime('%Y-%m-%d'))
    canvas.drawRightString(192*mm, 12*mm, str(doc.page))
    canvas.restoreState()

SimpleDocTemplate(str(OUT), pagesize=(210*mm, 297*mm), rightMargin=18*mm, leftMargin=18*mm, topMargin=18*mm, bottomMargin=23*mm, title='JPXFORGE - Continuidade', author='JPXFORGE / Codex').build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
