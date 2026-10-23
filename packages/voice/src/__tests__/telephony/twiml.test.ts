import { describe, it, expect } from 'vitest';
import { escapeXml, twilioStreamTwiml } from '../../telephony/twiml';
import { TWILIO_SESSION_TOKEN_PARAMETER } from '../../telephony/twilio-security';

describe('twilioStreamTwiml', () => {
  it('connects the call to a bidirectional stream with its parameters', () => {
    expect(
      twilioStreamTwiml({
        url: 'wss://voice.example.com/twilio',
        token: 'tok_123',
        parameters: { caller: '+15550001' },
        statusCallback: 'https://voice.example.com/status',
        statusCallbackMethod: 'POST',
      })
    ).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>' +
        '<Stream url="wss://voice.example.com/twilio" statusCallback="https://voice.example.com/status" statusCallbackMethod="POST">' +
        '<Parameter name="caller" value="+15550001"/>' +
        `<Parameter name="${TWILIO_SESSION_TOKEN_PARAMETER}" value="tok_123"/>` +
        '</Stream></Connect></Response>'
    );
  });

  it('escapes attribute values', () => {
    const twiml = twilioStreamTwiml({
      url: 'wss://voice.example.com/twilio',
      name: `a"b'c`,
      parameters: { note: '<script>&"x"</script>' },
    });
    expect(twiml).toContain('name="a&quot;b&apos;c"');
    expect(twiml).toContain('value="&lt;script&gt;&amp;&quot;x&quot;&lt;/script&gt;"');
    expect(twiml).not.toContain('<script>');
  });

  it('refuses URLs Twilio cannot stream to', () => {
    expect(() => twilioStreamTwiml({ url: 'ws://voice.example.com/twilio' })).toThrow('wss://');
    expect(() => twilioStreamTwiml({ url: 'wss://voice.example.com/twilio?x=1' })).toThrow(
      'query string'
    );
    expect(() => twilioStreamTwiml({ url: 'not a url' })).toThrow('not a URL');
  });

  it('refuses parameters that are too long or take the token name', () => {
    expect(() =>
      twilioStreamTwiml({ url: 'wss://a.example/s', parameters: { k: 'v'.repeat(500) } })
    ).toThrow('too long');
    expect(() =>
      twilioStreamTwiml({
        url: 'wss://a.example/s',
        token: 't',
        parameters: { [TWILIO_SESSION_TOKEN_PARAMETER]: 'x' },
      })
    ).toThrow('reserved');
  });

  it('refuses control characters XML cannot hold', () => {
    expect(() => escapeXml('a\u0001b')).toThrow('control characters');
    expect(escapeXml('tab\tline\n')).toBe('tab\tline\n');
  });
});
