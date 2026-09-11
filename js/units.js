/* Display conversion only. Simulation temperatures and control values stay Celsius. */
(function(root) {
  'use strict';
  function text(value, fahrenheit) {
    const source = String(value);
    if (!fahrenheit) return source;
    return source.replace(/([-−]?[0-9]+(?:\.[0-9]+)?(?:\s*(?:–|—|-|to|\/)\s*[-−]?[0-9]+(?:\.[0-9]+)?)*)(\+?)\s*°C(\s+(?:cooler|hotter))?/g, (match, values, plus, delta, offset) => {
      const difference = delta || /(?:off by|centre fell)\s*$/i.test(source.slice(0,offset)) || /^\s+(?:past the top|short of|from its peak)/.test(source.slice(offset+match.length));
      return values.replace(/(^|[–—/]|to|(?<=[0-9])-)(\s*)([-−]?[0-9]+(?:\.[0-9]+)?)/g, (_, separator, space, n) => {
        const converted = (Number(n.replace('−', '-'))*1.8 + (difference ? 0 : 32)).toFixed(n.includes('.') ? 1 : 0);
        return separator + space + (converted === '-0' ? '0' : converted);
      }) + plus + ' °F' + (delta || '');
    }).replace(/°C/g, '°F');
  }
  const api = {text};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TemperatureUnits = api;
})(typeof window !== 'undefined' ? window : globalThis);
