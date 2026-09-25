// Inworld STT y DeepSeek falsos:  node test/fake-voice.mjs 59048
//   INWORLD_STT_URL=http://127.0.0.1:59048/stt/v1/transcribe  DEEPSEEK_URL=http://127.0.0.1:59048
// GET /sent: lo recibido. POST /fail: la próxima transcripción responde 500.
import http from 'node:http';
const sent = [];
let failNext = false, failLlm = false;
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/sent') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sent));
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (req.url === '/fail') { failNext = true; return res.writeHead(204).end(); }
    if (req.url === '/fail-llm') { failLlm = true; return res.writeHead(204).end(); }
    const body = data ? JSON.parse(data) : {};
    if (req.url === '/stt/v1/transcribe') {
      const audio = Buffer.from(body.audioData?.content ?? '', 'base64');
      sent.push({ kind: 'stt', auth: req.headers.authorization, config: body.transcribeConfig, bytes: audio.length, head: audio.subarray(0, 12).toString('latin1') });
      // Como Inworld: con AUTO_DETECT solo WAV, MP3, OGG, FLAC, M4A y WebM; PCM crudo se rechaza.
      const known = audio.toString('latin1', 0, 4) === 'RIFF' || audio.toString('latin1', 4, 8) === 'ftyp' || audio.readUInt32BE(0) === 0x1a45dfa3 || ['OggS', 'fLaC', 'ID3'].some((m) => audio.toString('latin1', 0, m.length) === m);
      if (body.transcribeConfig?.audioEncoding !== 'AUTO_DETECT' || !known) return res.writeHead(400, { 'content-type': 'application/json' }).end('{"message":"only WAV, MP3, OGG, FLAC, M4A, and WebM are supported"}');
      if (failNext) { failNext = false; return res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"falla simulada"}'); }
      const text = audio.includes('compromiso') ? 'Hola Beto, el jueves te mando el contrato revisado con los cambios de la cláusula cuatro'
        : body.transcribeConfig?.language?.startsWith('en') ? 'hello team please send the contract tomorrow' : 'hola equipo por favor envíen el contrato firmado mañana temprano';
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ transcription: { transcript: text, wordTimestamps: [] }, usage: { transcribedAudioMs: 2000 } }));
    }
    if (req.url === '/chat/completions') {
      sent.push({ kind: 'llm', auth: req.headers.authorization, model: body.model, messages: body.messages });
      if (failLlm) { failLlm = false; return res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"falla simulada"}'); }
      const sys = body.messages?.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('sidechat')) {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ summary: 'Lo consulté: aplica la cláusula 4 con tope del 10 %.' }) } }] }));
      }
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      const content = user.includes('te mando')
        ? JSON.stringify({ summary: null, suggestedIssue: 'Enviar el contrato revisado el jueves' })
        : JSON.stringify({ summary: 'Piden el contrato firmado para mañana', suggestedIssue: 'Enviar el contrato firmado' });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    }
    res.writeHead(404).end();
  });
}).listen(Number(process.argv[2] ?? 59048), '127.0.0.1', () => console.log('fake-voice listo'));
