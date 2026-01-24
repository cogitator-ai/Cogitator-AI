interface XmlInput {
  xml: string;
  query?: string;
}

interface XmlNode {
  type: 'element' | 'text' | 'cdata' | 'comment';
  name?: string;
  attributes?: Record<string, string>;
  children?: XmlNode[];
  value?: string;
}

type XmlResult = XmlNode | XmlNode[] | string | string[] | null;

interface XmlOutput {
  result: XmlResult;
  type: 'document' | 'element' | 'text' | 'array';
  error?: string;
}

function parseXml(xml: string): XmlNode {
  let pos = 0;

  const skipWhitespace = () => {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
  };

  const parseAttributes = (): Record<string, string> => {
    const attrs: Record<string, string> = {};

    while (pos < xml.length) {
      skipWhitespace();

      if (xml[pos] === '>' || xml[pos] === '/' || xml[pos] === '?') break;

      let name = '';
      while (pos < xml.length && /[a-zA-Z0-9_:-]/.test(xml[pos])) {
        name += xml[pos++];
      }

      if (!name) break;

      skipWhitespace();

      if (xml[pos] !== '=') {
        attrs[name] = 'true';
        continue;
      }
      pos++;

      skipWhitespace();

      const quote = xml[pos];
      if (quote !== '"' && quote !== "'") {
        throw new Error(`Expected quote at position ${pos}`);
      }
      pos++;

      let value = '';
      while (pos < xml.length && xml[pos] !== quote) {
        if (xml[pos] === '&') {
          const entity = parseEntity();
          value += entity;
        } else {
          value += xml[pos++];
        }
      }
      pos++;

      attrs[name] = value;
    }

    return attrs;
  };

  const parseEntity = (): string => {
    let entity = '';
    pos++;
    while (pos < xml.length && xml[pos] !== ';') {
      entity += xml[pos++];
    }
    pos++;

    switch (entity) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (entity.startsWith('#x')) {
          return String.fromCharCode(parseInt(entity.slice(2), 16));
        } else if (entity.startsWith('#')) {
          return String.fromCharCode(parseInt(entity.slice(1), 10));
        }
        return `&${entity};`;
    }
  };

  const parseText = (): string => {
    let text = '';
    while (pos < xml.length && xml[pos] !== '<') {
      if (xml[pos] === '&') {
        text += parseEntity();
      } else {
        text += xml[pos++];
      }
    }
    return text;
  };

  const parseNode = (): XmlNode | null => {
    skipWhitespace();

    if (pos >= xml.length) return null;

    if (xml[pos] !== '<') {
      const text = parseText().trim();
      if (text) {
        return { type: 'text', value: text };
      }
      return null;
    }

    pos++;

    if (xml.slice(pos, pos + 3) === '!--') {
      pos += 3;
      const endPos = xml.indexOf('-->', pos);
      if (endPos === -1) throw new Error('Unclosed comment');
      const value = xml.slice(pos, endPos);
      pos = endPos + 3;
      return { type: 'comment', value };
    }

    if (xml.slice(pos, pos + 8) === '![CDATA[') {
      pos += 8;
      const endPos = xml.indexOf(']]>', pos);
      if (endPos === -1) throw new Error('Unclosed CDATA');
      const value = xml.slice(pos, endPos);
      pos = endPos + 3;
      return { type: 'cdata', value };
    }

    if (xml[pos] === '?') {
      const endPos = xml.indexOf('?>', pos);
      if (endPos === -1) throw new Error('Unclosed processing instruction');
      pos = endPos + 2;
      return parseNode();
    }

    if (xml[pos] === '!') {
      const endPos = xml.indexOf('>', pos);
      if (endPos === -1) throw new Error('Unclosed declaration');
      pos = endPos + 1;
      return parseNode();
    }

    if (xml[pos] === '/') {
      return null;
    }

    let name = '';
    while (pos < xml.length && /[a-zA-Z0-9_:-]/.test(xml[pos])) {
      name += xml[pos++];
    }

    if (!name) throw new Error(`Expected element name at position ${pos}`);

    const attributes = parseAttributes();

    skipWhitespace();

    if (xml.slice(pos, pos + 2) === '/>') {
      pos += 2;
      return { type: 'element', name, attributes, children: [] };
    }

    if (xml[pos] !== '>') {
      throw new Error(`Expected > at position ${pos}`);
    }
    pos++;

    const children: XmlNode[] = [];

    while (pos < xml.length) {
      skipWhitespace();

      if (xml.slice(pos, pos + 2) === '</') {
        pos += 2;
        let closeName = '';
        while (pos < xml.length && /[a-zA-Z0-9_:-]/.test(xml[pos])) {
          closeName += xml[pos++];
        }
        skipWhitespace();
        if (xml[pos] !== '>') throw new Error(`Expected > at position ${pos}`);
        pos++;

        if (closeName !== name) {
          throw new Error(`Mismatched tags: ${name} vs ${closeName}`);
        }
        break;
      }

      const child = parseNode();
      if (child) {
        children.push(child);
      } else if (xml[pos] !== '<') {
        break;
      }
    }

    return { type: 'element', name, attributes, children };
  };

  const root = parseNode();
  if (!root) throw new Error('Empty document');

  return root;
}

function queryXml(node: XmlNode, query: string): XmlNode | XmlNode[] | string | string[] | null {
  const parts = query.split('/').filter((p) => p);

  if (parts.length === 0) return node;

  let current: XmlNode | XmlNode[] | string[] = node;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part.startsWith('@')) {
      const attrName = part.slice(1);
      if (Array.isArray(current)) {
        return current
          .filter((n) => n.type === 'element' && n.attributes?.[attrName])
          .map((n) => n.attributes![attrName]);
      }
      if (current.type === 'element' && current.attributes?.[attrName]) {
        return current.attributes[attrName];
      }
      return null;
    }

    const isRecursive = part === '';
    if (isRecursive) {
      i++;
      if (i >= parts.length) return null;
      const targetName = parts[i];
      const results: XmlNode[] = [];

      const findAll = (n: XmlNode) => {
        if (n.type === 'element') {
          if (n.name === targetName) results.push(n);
          if (n.children) n.children.forEach(findAll);
        }
      };

      if (Array.isArray(current)) {
        current.forEach(findAll);
      } else {
        findAll(current);
      }

      current = results;
      continue;
    }

    if (Array.isArray(current)) {
      const results: XmlNode[] = [];
      for (const n of current) {
        if (n.type === 'element' && n.children) {
          for (const child of n.children) {
            if (child.type === 'element' && child.name === part) {
              results.push(child);
            }
          }
        }
      }
      current = results;
    } else {
      if (current.type !== 'element' || !current.children) return null;

      const matches: XmlNode[] = current.children.filter(
        (c): c is XmlNode => c.type === 'element' && c.name === part
      );

      if (matches.length === 0) return null;
      if (matches.length === 1) {
        current = matches[0];
      } else {
        current = matches;
      }
    }
  }

  return current;
}

export function xml(): number {
  try {
    const inputStr = Host.inputString();
    const input: XmlInput = JSON.parse(inputStr);

    const parsed = parseXml(input.xml);

    let result: XmlResult = parsed;
    let type: 'document' | 'element' | 'text' | 'array' = 'document';

    if (input.query) {
      result = queryXml(parsed, input.query);

      if (result === null) {
        type = 'element';
      } else if (typeof result === 'string') {
        type = 'text';
      } else if (Array.isArray(result)) {
        type = 'array';
      } else {
        type = 'element';
      }
    }

    const output: XmlOutput = {
      result,
      type,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: XmlOutput = {
      result: null,
      type: 'document',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
