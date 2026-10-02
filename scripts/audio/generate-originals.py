"""Original Chaggu notification tones. Code and output dedicated to CC0-1.0.
No sampled recordings or third-party melodies. Run from repository root.
"""
import math, struct, wave
from pathlib import Path
RECIPES = {
 'energy': [(220,0,.14,'triangle',.09),(440,.1,.16,'triangle',.09),(880,.22,.25,'sine',.1)],
 'spark': [(1760,0,.12,'sine',.1),(2349.3,.07,.2,'sine',.07)],
 'portal': [(784,0,.32,'sine',.08),(523.3,.09,.35,'triangle',.07),(392,.18,.35,'sine',.07)],
 'victory': [(523.3,0,.12,'triangle',.09),(659.3,.1,.12,'triangle',.09),(784,.2,.12,'triangle',.09),(1046.5,.3,.26,'sine',.1)]}
out=Path('apps/web/public/sounds');out.mkdir(parents=True,exist_ok=True)
for name,notes in RECIPES.items():
 rate=44100; samples=[]
 for i in range(math.ceil((max(at+d for f,at,d,w,p in notes)+.03)*rate)):
  t=i/rate; sample=0
  for f,at,d,shape,peak in notes:
   x=t-at
   if not 0<=x<d: continue
   env=.0001*(peak/.0001)**(x/.012) if x<.012 else peak*(.0001/peak)**((x-.012)/(d-.012))
   v=math.sin(2*math.pi*f*x)
   if shape=='triangle':v=2/math.pi*math.asin(v)
   sample+=v*env
  samples.append(struct.pack('<h',round(max(-1,min(1,sample))*32767)))
 with wave.open(str(out/(name+'.wav')),'wb') as w:
  w.setnchannels(1);w.setsampwidth(2);w.setframerate(rate);w.writeframes(b''.join(samples))
 print(name,len(samples)/rate)
