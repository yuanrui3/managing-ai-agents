"""Rasterize the desktop diagram renderer's fixed set of SVG elements."""

import base64
import io
import re
import sys
from xml.etree import ElementTree

from PIL import Image, ImageDraw, ImageFont


data = sys.stdin.buffer.read(256_001)
if len(data) > 256_000 or b'<!' in data:
    raise ValueError('Invalid diagram input')

root = ElementTree.fromstring(data)
namespace = '{http://www.w3.org/2000/svg}'
if root.tag != namespace + 'svg' or len(root) > 102:
    raise ValueError('Unexpected diagram format')

image = Image.new('RGB', (640, 400), '#ffffff')
draw = ImageDraw.Draw(image)
font = ImageFont.load_default(size=17)


def numbers(element, *fields):
    return [float(element.attrib[field]) for field in fields]


def ink(element, field):
    value = element.attrib[field]
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('Unexpected diagram color')
    return value


for element in root:
    kind = element.tag.removeprefix(namespace)
    if kind == 'title':
        continue
    if kind == 'line':
        draw.line(numbers(element, 'x1', 'y1', 'x2', 'y2'), fill=ink(element, 'stroke'), width=3)
    elif kind == 'rect':
        x, y, width, height = numbers(element, 'x', 'y', 'width', 'height') if 'x' in element.attrib else (0, 0, 640, 400)
        draw.rectangle((x, y, x + width, y + height), fill=ink(element, 'fill'))
    elif kind == 'circle':
        x, y, radius = numbers(element, 'cx', 'cy', 'r')
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=ink(element, 'fill'))
    elif kind == 'polyline':
        points = [tuple(map(float, pair.split(','))) for pair in element.attrib['points'].split()]
        draw.line(points, fill=ink(element, 'stroke'), width=3)
    elif kind == 'text':
        draw.text(tuple(numbers(element, 'x', 'y')), element.text or '', font=font, anchor='ls', fill=ink(element, 'fill'))
    else:
        raise ValueError('Unexpected diagram element')

buffer = io.BytesIO()
image.save(buffer, format='PNG')
sys.stdout.write(base64.b64encode(buffer.getvalue()).decode('ascii'))
