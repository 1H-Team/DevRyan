export const assistantImageSyntaxFixtures = [
  {
    name: 'inline image, balanced destination, angle destination, and image link',
    markdown: [
      '![Chart](./art/chart(final).png)',
      '![Wide chart](<./art/wide chart.webp>)',
      '[Download JPG](./art/photo.jpg?download=1)',
    ].join('\n'),
    expected: [
      { source: './art/chart(final).png', caption: 'Chart', kind: 'markdown-image' },
      { source: './art/wide chart.webp', caption: 'Wide chart', kind: 'markdown-image' },
      { source: './art/photo.jpg?download=1', caption: 'Download JPG', kind: 'markdown-link' },
    ],
  },
  {
    name: 'reference images resolve definitions declared later',
    markdown: 'Before ![First][hero] and ![Second][].\n\n[hero]: /tmp/hero.png\n[Second]: <https://cdn.example/second.gif>',
    expected: [
      { source: '/tmp/hero.png', caption: 'First', kind: 'reference-image' },
      { source: 'https://cdn.example/second.gif', caption: 'Second', kind: 'reference-image' },
    ],
  },
  {
    name: 'escaped and code-contained syntax is ignored',
    markdown: '\\![escaped](escaped.png) `![inline](inline.png)`\n```md\n![fenced](fenced.png)\n```\n![real](real.jpeg)',
    expected: [
      { source: 'real.jpeg', caption: 'real', kind: 'markdown-image' },
    ],
  },
  {
    name: 'supported data image is accepted and SVG is rejected',
    markdown: '![pixel](data:image/png;base64,iVBORw0KGgo=) ![vector](vector.svg)',
    expected: [
      { source: 'data:image/png;base64,iVBORw0KGgo=', caption: 'pixel', kind: 'markdown-image' },
    ],
  },
];
