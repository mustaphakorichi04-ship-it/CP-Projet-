// fix-sri.js
// Usage : node fix-sri.js
// Remplace TOUS les placeholders <HASH_XXX> dans index.html par les vrais SRI

const fs = require('fs');

const HASHES = {
    '<HASH_XLSX>':        'vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw',
    '<HASH_CHART>':       'e6nUZLBkQ86NJ6TVVKAeSaK8jWa3NhkYWZFomE39AvDbQWeie9PlQqM3pmYW5d1g',
    '<HASH_JSPDF>':       'JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
    '<HASH_LEAFLET_JS>':  'cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH',
    '<HASH_MC_JS>':       'RLIyj5q1b5XJTn0tqUhucRZe40nFTocRP91R/NkRJHwAe4XxnTV77FXy/vGLiec2',
    '<HASH_THREE>':       'CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu',
    '<HASH_ORBIT>':       'wagZhIFgY4hD+7awjQjR4e2E294y6J2HSnd8eTNc15ZubTeQeVRZwhQJ+W6hnBsf'
};

const FILE = 'index.html';
let html = fs.readFileSync(FILE, 'utf8');
let totalReplacements = 0;

for (const [placeholder, hash] of Object.entries(HASHES)) {
    const re = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const count = (html.match(re) || []).length;
    html = html.replace(re, hash);
    if (count > 0) {
        console.log(`  ✅ ${placeholder} → remplacé (${count}x)`);
        totalReplacements += count;
    }
}

fs.writeFileSync(FILE, html);
console.log(`\n📊 Total : ${totalReplacements} remplacement(s).`);