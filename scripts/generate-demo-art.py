"""Create original, deterministic sample media artwork (Pillow; development only)."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
root = Path(__file__).resolve().parents[1] / 'desktop/assets'
font_root = Path('/System/Library/Fonts/Supplemental')
def font(size, bold=False):
    return ImageFont.truetype(str(font_root / ('Arial Bold.ttf' if bold else 'Arial.ttf')), size)
def text(d,xy,value,size=16,color='#73737e',bold=False):
    d.text(xy,value,font=font(size,bold),fill=color)
def pill(d,box,color): d.rounded_rectangle(box, radius=8, fill=color)
img=Image.new('RGB',(1280,720),'#faf9fc');d=ImageDraw.Draw(img)
d.rectangle((0,0,1280,48), fill='#f0eef4')
for x,c in [(23,'#ed817f'),(45,'#e9c166'),(67,'#88bd8d')]: d.ellipse((x,18,x+11,29),fill=c)
pill(d,(463,12,817,36),'#e7e3ec');text(d,(580,17),'studio / projects',12,'#938b9d')
d.rectangle((0,48,218,720),fill='#f1eff6');d.line((218,48,218,720),fill='#e7e3ed')
pill(d,(24,75,55,106),'#7b61ab');text(d,(32,78),'a',23,'#ffffff',True);text(d,(67,80),'arcspace',23,'#34313b',True)
text(d,(28,141),'WORKSPACE',10,'#aaa0b5',True)
for n,(label,count) in enumerate([('Overview',''),('Projects','8'),('My tasks','12'),('Calendar','')]):
    y=172+n*44
    if n==1:pill(d,(15,y-8,203,y+27),'#e0d6ef')
    d.rounded_rectangle((28,y+2,40,y+14),radius=3,outline='#a899bd',width=2)
    text(d,(52,y),label,14,'#78539c' if n==1 else '#7f738d',n==1)
    text(d,(171,y),count,12,'#a493b5')
text(d,(28,389),'FAVORITES',10,'#aaa0b5',True)
for n,(label,c) in enumerate([('Website launch','#b79bdd'),('Brand refresh','#ddba8d'),('Product updates','#86b8a4')]):
    y=423+n*37;d.ellipse((30,y+3,36,y+9),fill=c);text(d,(51,y-1),label,13,'#8d7f9b')
d.line((23,645,195,645),fill='#e4deeb')
d.ellipse((27,670,52,695),fill='#d7c5e8');text(d,(65,674),'Sample workspace',12,'#91839d')
text(d,(258,79),'Projects  /  Website launch',13,'#a497b0')
text(d,(258,122),'Make something great.',33,'#332b40',True)
text(d,(259,168),'A little focus. A few good ideas. A new beginning.',15,'#9a8aa9')
pill(d,(1099,119,1237,155),'#7852a7');text(d,(1116,129),'+  New task',13,'#ffffff',True)
for x,label,sel in [(259,'Board',True),(334,'Timeline',False),(434,'Files',False)]:
    text(d,(x,221),label,13,'#7852a7' if sel else '#a193ad',sel)
d.line((257,256,1236,256),fill='#e9e3ef');d.line((258,255,302,255),fill='#9b72ca',width=3)
text(d,(1085,219),'Filter     Sort   ···',13,'#a493b0')
cards=[('To do','#c8b4e0',[('DESIGN','Explore the possibilities','A new direction for our homepage.','#dac9ee'),('RESEARCH','Find the right words','A story worth sharing.','#ead6b9')]),('In progress','#a68acf',[('WEBSITE','Build a beautiful first impression','Small details. Big difference.','#d1bce8'),('CONTENT','Show, don’t just tell','Record a short product walkthrough.','#c8ddd1')]),('Done','#89b8a3',[('PLANNING','Start with the essentials','Everything we need, in one place.','#c6dfd0'),('DESIGN','Set the tone','Colors, type, and a little personality.','#dcd0ea')])]
for col,(title,c,items) in enumerate(cards):
    x=258+col*335
    d.ellipse((x,281,x+8,289),fill=c);text(d,(x+19,276),title,14,'#82718f',True);text(d,(x+126,277),'2',12,'#b2a4bc')
    text(d,(x+280,275),'+   ···',13,'#b5a7bf')
    for j,(tag,name,desc,c) in enumerate(items):
        y=314+j*164
        d.rounded_rectangle((x,y,x+309,y+147),radius=12,fill='#ffffff',outline='#e8e0ee',width=1)
        pill(d,(x+17,y+15,x+17+len(tag)*6+18,y+35),c);text(d,(x+25,y+20),tag,9,'#897099',True)
        text(d,(x+17,y+54),name,14,'#685374',True);text(d,(x+17,y+81),desc,12,'#ad9ab8')
        d.line((x+17,y+109,x+290,y+109),fill='#f2ecf5');text(d,(x+17,y+122),'Oct 14     ·     3 subtasks',10,'#b7a5c0')
        d.ellipse((x+265,y+118,x+286,y+139),fill=c)
text(d,(259,673),'All your ideas, moving forward.',11,'#b7a8c1')
img.save(root/'demo-screen.png')
# A clearly illustrated webcam placeholder, not a real person.
img=Image.new('RGB',(640,480)); px=img.load()
for y in range(480):
    for x in range(640):
        v=(x/640+y/480)/2
        px[x,y]=(int(205-25*v),int(191-29*v),int(222-15*v))
d=ImageDraw.Draw(img)
d.ellipse((-80,-160,320,240),fill='#d5c3e1');d.ellipse((400,280,800,680),fill='#a98ac0')
d.rounded_rectangle((135,343,505,650),radius=125,fill='#79608f')
d.rounded_rectangle((223,134,420,368),radius=92,fill='#e2b9ae')
d.ellipse((225,115,419,290),fill='#473b57')
d.rounded_rectangle((240,189,405,360),radius=70,fill='#e2b9ae')
d.pieslice((222,108,420,275),180,345,fill='#473b57')
d.ellipse((275,251,283,260),fill='#55455f');d.ellipse((357,251,365,260),fill='#55455f')
d.arc((300,280,342,307),0,175,fill='#ac7982',width=3)
text(d,(25,446),'ILLUSTRATED SAMPLE CAMERA',11,'#78628d',True)
img.save(root/'demo-camera.png')
# Keep the macOS icon generator shared with standalone icon updates.
from generate_app_icon import generate_icon
generate_icon(root)
