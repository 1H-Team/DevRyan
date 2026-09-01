const invalid = () => Object.assign(new Error('Speech audio is invalid or unsupported'), {
  code: 'bot_voice_audio_invalid', statusCode: 400,
});

const opusDuration = (bytes) => {
  let offset = 0;
  let serial = null;
  let sequence = 0;
  let preSkip = 0;
  let maximumGranule = 0n;
  let ended = false;
  let audioPages = 0;
  let packetBytes = [];
  let packetLength = 0;
  let packetDuration = 0;
  while (offset < bytes.length) {
    if (ended || offset + 27 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'OggS'
      || bytes[offset + 4] !== 0) throw invalid();
    const count = bytes[offset + 26];
    const headerEnd = offset + 27 + count;
    if (headerEnd > bytes.length) throw invalid();
    let size = 0;
    for (let index = offset + 27; index < headerEnd; index += 1) size += bytes[index];
    if (headerEnd + size > bytes.length) throw invalid();
    let packetOffset = headerEnd;
    for (let index = offset + 27; index < headerEnd; index += 1) {
      const length = bytes[index];
      packetBytes.push(bytes.subarray(packetOffset, packetOffset + length));
      packetLength += length;
      if (packetLength > 128 * 1024) throw invalid();
      packetOffset += length;
      if (length === 255) continue;
      const packet = Buffer.concat(packetBytes, packetLength);
      packetBytes = [];
      packetLength = 0;
      const kind = packet.toString('ascii', 0, 8);
      if (kind === 'OpusHead' || kind === 'OpusTags') continue;
      if (packet.length < 1) throw invalid();
      const config = packet[0] >> 3;
      const frameMilliseconds = config >= 16 ? 2.5 * (2 ** (config & 3))
        : config >= 12 ? 10 * (2 ** (config & 1))
          : (config & 3) === 3 ? 60 : 10 * (2 ** (config & 3));
      const mode = packet[0] & 3;
      const count = mode === 0 ? 1 : mode === 3 ? (packet[1] & 63) : 2;
      if (!count || frameMilliseconds * count > 120) throw invalid();
      packetDuration += frameMilliseconds * count / 1_000;
    }
    const nextSerial = bytes.readUInt32LE(offset + 14);
    if (serial !== null && serial !== nextSerial) throw invalid();
    serial = nextSerial;
    if (bytes.readUInt32LE(offset + 18) !== sequence++) throw invalid();
    if (offset === 0) {
      if (!(bytes[offset + 5] & 2) || size < 19
        || bytes.toString('ascii', headerEnd, headerEnd + 8) !== 'OpusHead') throw invalid();
      preSkip = bytes.readUInt16LE(headerEnd + 10);
    } else if (bytes.toString('ascii', headerEnd, headerEnd + 8) !== 'OpusTags') audioPages += 1;
    const granule = bytes.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn) maximumGranule = granule;
    ended = (bytes[offset + 5] & 4) !== 0;
    offset = headerEnd + size;
  }
  if (!ended || packetLength || audioPages < 1 || maximumGranule <= BigInt(preSkip)) throw invalid();
  const duration = Number(maximumGranule - BigInt(preSkip)) / 48_000;
  if (Math.abs(duration - packetDuration) > 0.12 + preSkip / 48_000) throw invalid();
  return Math.max(duration, packetDuration - preSkip / 48_000);
};

const mp3Duration = (bytes) => {
  let offset = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes.subarray(6, 10).some((byte) => byte > 127)) throw invalid();
    offset = 10 + bytes.subarray(6, 10).reduce((sum, byte) => sum * 128 + byte, 0)
      + (bytes[5] & 16 ? 10 : 0);
  }
  let duration = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes.length - offset === 128 && bytes.toString('ascii', offset, offset + 3) === 'TAG') {
      offset += 128;
      break;
    }
    const [a, b, c] = bytes.subarray(offset, offset + 3);
    const version = (b >> 3) & 3;
    const layer = (b >> 1) & 3;
    const rateIndex = (c >> 2) & 3;
    const bitrateIndex = c >> 4;
    if (a !== 255 || (b & 224) !== 224 || version === 1 || layer !== 1
      || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) throw invalid();
    const sampleRate = [44_100, 48_000, 32_000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex] * 1_000;
    const frameSize = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((c >> 1) & 1);
    if (offset + frameSize > bytes.length) throw invalid();
    duration += (version === 3 ? 1152 : 576) / sampleRate;
    frames += 1;
    offset += frameSize;
  }
  if (frames < 1 || offset !== bytes.length) throw invalid();
  return duration;
};

export const inspectBotVoiceAudio = (bytes, contentType, maximumSeconds = 300) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 20 * 1024 * 1024) throw invalid();
  const mime = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  let duration;
  let normalizedType;
  if (['audio/ogg', 'application/ogg', 'audio/opus'].includes(mime)) {
    duration = opusDuration(bytes);
    normalizedType = 'audio/ogg';
  } else if (['audio/mpeg', 'audio/mp3'].includes(mime)) {
    duration = mp3Duration(bytes);
    normalizedType = 'audio/mpeg';
  } else throw invalid();
  if (!Number.isFinite(duration) || duration <= 0 || duration > maximumSeconds) {
    throw Object.assign(new Error('Speech audio exceeds the duration limit'), { code: 'bot_voice_duration_exceeded', statusCode: 413 });
  }
  return Object.freeze({ duration, contentType: normalizedType, extension: normalizedType === 'audio/ogg' ? 'ogg' : 'mp3' });
};
