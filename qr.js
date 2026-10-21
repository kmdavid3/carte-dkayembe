/* Générateur de QR code minimal (mode octet, UTF-8), sans dépendance.
   Implémentation de la norme ISO/IEC 18004, structure inspirée de la bibliothèque
   « QR Code generator » de Project Nayuki (licence MIT).
   Usage : SILSQR.encode("texte", "M") -> { size, get(x, y) } */
(function (global) {
  "use strict";

  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var FORMAT_ECL_BITS = [1, 0, 3, 2];
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  function getBit(value, index) { return ((value >>> index) & 1) !== 0; }

  function utf8Bytes(text) {
    if (global.TextEncoder) return Array.prototype.slice.call(new TextEncoder().encode(text));
    var binary = unescape(encodeURIComponent(text));
    var out = [];
    for (var i = 0; i < binary.length; i++) out.push(binary.charCodeAt(i));
    return out;
  }

  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  }

  /* Reed-Solomon sur GF(2^8), polynôme 0x11D. */
  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= rsMultiply(coef, factor); });
    });
    return result;
  }

  function encode(text, level) {
    var ecl = ECL[level || "M"];
    var bytes = utf8Bytes(text);
    var ver;
    for (ver = 1; ; ver++) {
      var ccBits = ver < 10 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= numDataCodewords(ver, ecl) * 8) break;
      if (ver >= 40) throw new RangeError("Texte trop long pour un QR code");
    }

    // Flux de bits : mode octet, longueur, données, terminateur, bourrage.
    var bits = [];
    function append(value, length) { for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    append(0x4, 4);
    append(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { append(b, 8); });
    var capacity = numDataCodewords(ver, ecl) * 8;
    append(0, Math.min(4, capacity - bits.length));
    append(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) append(pad, 8);
    var data = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
      data.push(byte);
    }

    // Blocs, correction d'erreurs et entrelacement.
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    var eccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    var raw = Math.floor(numRawDataModules(ver) / 8);
    var numShort = numBlocks - raw % numBlocks;
    var shortLen = Math.floor(raw / numBlocks);
    var divisor = rsDivisor(eccLen);
    var blocks = [];
    for (var i = 0, offset = 0; i < numBlocks; i++) {
      var chunk = data.slice(offset, offset + shortLen - eccLen + (i < numShort ? 0 : 1));
      offset += chunk.length;
      var ecc = rsRemainder(chunk, divisor);
      if (i < numShort) chunk.push(0);
      blocks.push(chunk.concat(ecc));
    }
    var codewords = [];
    for (var c = 0; c < blocks[0].length; c++) {
      blocks.forEach(function (block, j) {
        if (c !== shortLen - eccLen || j >= numShort) codewords.push(block[c]);
      });
    }

    var size = ver * 4 + 17;
    var modules = [], isFunction = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }
    function setFunction(x, y, dark) { modules[y][x] = dark; isFunction[y][x] = true; }

    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = cx + dx, yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
    function drawAlignment(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    function alignmentPositions() {
      if (ver === 1) return [];
      var numAlign = Math.floor(ver / 7) + 2;
      var step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
      var result = [6];
      for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
      return result;
    }
    function drawFormat(mask) {
      var value = FORMAT_ECL_BITS[ecl] << 3 | mask;
      var rem = value;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var f = (value << 10 | rem) ^ 0x5412;
      for (var a = 0; a <= 5; a++) setFunction(8, a, getBit(f, a));
      setFunction(8, 7, getBit(f, 6));
      setFunction(8, 8, getBit(f, 7));
      setFunction(7, 8, getBit(f, 8));
      for (var b2 = 9; b2 < 15; b2++) setFunction(14 - b2, 8, getBit(f, b2));
      for (var d = 0; d < 8; d++) setFunction(size - 1 - d, 8, getBit(f, d));
      for (var e = 8; e < 15; e++) setFunction(8, size - 15 + e, getBit(f, e));
      setFunction(8, size - 8, true);
    }
    function drawVersion() {
      if (ver < 7) return;
      var rem = ver;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var v = ver << 12 | rem;
      for (var j = 0; j < 18; j++) {
        var dark = getBit(v, j);
        var a = size - 11 + j % 3, b3 = Math.floor(j / 3);
        setFunction(a, b3, dark);
        setFunction(b3, a, dark);
      }
    }

    // Motifs fixes.
    for (var t = 0; t < size; t++) {
      setFunction(6, t, t % 2 === 0);
      setFunction(t, 6, t % 2 === 0);
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);
    var align = alignmentPositions();
    for (var ai = 0; ai < align.length; ai++) {
      for (var aj = 0; aj < align.length; aj++) {
        var corner = (ai === 0 && aj === 0) || (ai === 0 && aj === align.length - 1) || (ai === align.length - 1 && aj === 0);
        if (!corner) drawAlignment(align[ai], align[aj]);
      }
    }
    drawFormat(0);
    drawVersion();

    // Placement en zigzag des mots de code.
    var bitIndex = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var col = 0; col < 2; col++) {
          var x = right - col;
          var upward = ((right + 1) & 2) === 0;
          var yy = upward ? size - 1 - vert : vert;
          if (!isFunction[yy][x] && bitIndex < codewords.length * 8) {
            modules[yy][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var invert;
          switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = x * y % 2 + x * y % 3 === 0; break;
            case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
            default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0;
          }
          if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x];
        }
      }
    }

    function penalty() {
      var score = 0, dark = 0;
      function line(get) {
        var runColor = null, run = 0, pattern = "";
        for (var i = 0; i < size; i++) {
          var m = get(i);
          pattern += m ? "1" : "0";
          if (m === runColor) {
            run++;
            if (run === 5) score += 3; else if (run > 5) score++;
          } else { runColor = m; run = 1; }
        }
        var padded = "0000" + pattern + "0000";
        var re = /(?=(10111010000|00001011101))/g;
        while (re.exec(padded)) { score += 40; re.lastIndex++; }
      }
      for (var y = 0; y < size; y++) line(function (i) { return modules[y][i]; });
      for (var x = 0; x < size; x++) line(function (i) { return modules[i][x]; });
      for (var by = 0; by < size - 1; by++) {
        for (var bx = 0; bx < size - 1; bx++) {
          var m = modules[by][bx];
          if (m === modules[by][bx + 1] && m === modules[by + 1][bx] && m === modules[by + 1][bx + 1]) score += 3;
        }
      }
      for (var ry = 0; ry < size; ry++) for (var rx = 0; rx < size; rx++) if (modules[ry][rx]) dark++;
      var total = size * size;
      score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return score;
    }

    var bestMask = 0, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      applyMask(mask);
      drawFormat(mask);
      var s = penalty();
      if (s < bestScore) { bestScore = s; bestMask = mask; }
      applyMask(mask);
    }
    applyMask(bestMask);
    drawFormat(bestMask);

    return {
      size: size,
      version: ver,
      get: function (x, y) { return x >= 0 && x < size && y >= 0 && y < size && modules[y][x]; }
    };
  }

  /* Rend le QR code en SVG (chemins carrés, zone calme de 4 modules). */
  function toSvg(qr, options) {
    var border = 4, dim = qr.size + border * 2;
    var d = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.get(x, y)) d.push("M" + (x + border) + "," + (y + border) + "h1v1h-1z");
      }
    }
    var dark = (options && options.dark) || "#17243A";
    var light = (options && options.light) || "#FFFFFF";
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="' + light + '"/>' +
      '<path d="' + d.join("") + '" fill="' + dark + '"/></svg>';
  }

  var api = { encode: encode, toSvg: toSvg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.SILSQR = api;
})(typeof window !== "undefined" ? window : globalThis);
