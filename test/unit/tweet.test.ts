import assert from 'node:assert/strict';

import type { HttpRequest, HttpResponse } from '../../src/scraper';
import {
  type Tweet,
  fetchTweet,
  formatTweetEmbed,
  isTweetUrl,
  tweetIdOf,
} from '../../src/tweet';

/** A fake HTTP client that records every request it is asked to make. */
function fakeHttp(status: number, body: unknown) {
  const requests: HttpRequest[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    const bytes = new TextEncoder().encode(
      typeof body === 'string' ? body : JSON.stringify(body)
    );
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
    };
  };
  return { http, requests };
}

const author = {
  name: 'jack',
  screen_name: 'jack',
  id: '12',
};

/** A status in the FxEmbed API v2 shape, with the test's overrides. */
function status(overrides: Record<string, unknown> = {}) {
  return {
    type: 'status',
    id: '20',
    url: 'https://x.com/jack/status/20',
    text: 'just setting up my twttr',
    raw_text: {
      text: 'just setting up my twttr',
      display_text_range: [0, 24],
      facets: [],
    },
    author,
    created_at: 'Tue Mar 21 20:50:14 +0000 2006',
    created_timestamp: 1142974214,
    media: {},
    ...overrides,
  };
}

const ok = (tweet: Record<string, unknown>) => ({
  code: 200,
  status: tweet,
  thread: null,
  author,
});

const labels = { source: 'Original post', video: 'Video' };

describe('tweetIdOf', () => {
  it('reads the ID out of every shape of post URL', () => {
    assert.equal(tweetIdOf('https://x.com/jack/status/20'), '20');
    assert.equal(tweetIdOf('https://twitter.com/jack/status/20?s=20'), '20');
    assert.equal(
      tweetIdOf('https://mobile.twitter.com/jack/status/20/photo/1'),
      '20'
    );
    assert.equal(tweetIdOf('https://x.com/i/web/status/20'), '20');
    assert.equal(tweetIdOf('https://www.x.com/jack/status/20'), '20');
  });

  it('leaves other URLs alone', () => {
    assert.equal(tweetIdOf('https://x.com/jack'), null);
    assert.equal(tweetIdOf('https://example.com/jack/status/20'), null);
    assert.equal(tweetIdOf('https://x.com/jack/status/abc'), null);
    assert.equal(tweetIdOf('not a url'), null);
    assert.equal(isTweetUrl('https://x.com/jack/status/20'), true);
    assert.equal(isTweetUrl('https://example.com/'), false);
  });
});

describe('fetchTweet', () => {
  it('asks the API for the post by ID and parses its answer', async () => {
    const { http, requests } = fakeHttp(200, ok(status()));
    const tweet = await fetchTweet('https://x.com/jack/status/20', { http });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.fxtwitter.com/2/status/20');
    assert.equal(tweet?.text, 'just setting up my twttr');
    assert.equal(tweet?.author.name, 'jack');
    assert.equal(tweet?.author.screenName, 'jack');
    assert.equal(tweet?.date, '2006-03-21');
  });

  it('uses the API instance it is given', async () => {
    const { http, requests } = fakeHttp(200, ok(status()));
    await fetchTweet('https://x.com/jack/status/20', {
      http,
      apiBase: 'https://fx.example.com/',
    });
    assert.equal(requests[0].url, 'https://fx.example.com/2/status/20');
  });

  it('expands shortened links and drops the media link from the text', async () => {
    const rawText = 'Reading https://t.co/abc now https://t.co/pic';
    const linkAt = rawText.indexOf('https://t.co/abc');
    const mediaAt = rawText.indexOf('https://t.co/pic');
    const tweet = status({
      text: rawText,
      raw_text: {
        text: rawText,
        display_text_range: [0, rawText.length],
        facets: [
          {
            type: 'url',
            indices: [linkAt, linkAt + 'https://t.co/abc'.length],
            original: 'https://t.co/abc',
            replacement: 'https://example.com/post',
          },
          {
            type: 'media',
            indices: [mediaAt, mediaAt + 'https://t.co/pic'.length],
            original: 'https://t.co/pic',
          },
        ],
      },
      media: {
        photos: [
          {
            type: 'photo',
            url: 'https://pbs.twimg.com/media/abc.jpg',
            width: 800,
            height: 600,
            altText: 'A photo',
          },
        ],
      },
    });
    const { http } = fakeHttp(200, ok(tweet));
    const fetched = await fetchTweet('https://x.com/jack/status/20', { http });
    assert.equal(fetched?.text, 'Reading https://example.com/post now');
    assert.equal(fetched?.photos.length, 1);
    assert.equal(fetched?.photos[0].altText, 'A photo');
  });

  it('answers null for a post that is gone', async () => {
    const missing = fakeHttp(404, { code: 404, status: null });
    assert.equal(
      await fetchTweet('https://x.com/jack/status/20', {
        http: missing.http,
      }),
      null
    );
    const coded = fakeHttp(200, { code: 404, status: null });
    assert.equal(
      await fetchTweet('https://x.com/jack/status/20', { http: coded.http }),
      null
    );
  });

  it('answers null when the API cannot be reached or read', async () => {
    const broken = fakeHttp(200, 'not json');
    assert.equal(
      await fetchTweet('https://x.com/jack/status/20', { http: broken.http }),
      null
    );
    const down = async (): Promise<HttpResponse> => {
      throw new Error('network down');
    };
    assert.equal(
      await fetchTweet('https://x.com/jack/status/20', { http: down }),
      null
    );
  });
});

describe('formatTweetEmbed', () => {
  const base: Tweet = {
    id: '20',
    url: 'https://x.com/jack/status/20',
    text: 'just setting up my twttr',
    author: { name: 'jack', screenName: 'jack' },
    date: '2006-03-21',
    photos: [],
    videos: [],
    poll: null,
    quote: null,
  };

  it('writes a post as a blockquote with a link back', () => {
    assert.equal(
      formatTweetEmbed(base, { media: true, labels }),
      [
        '> **jack (@jack)** · 2006-03-21',
        '>',
        '> just setting up my twttr',
        '>',
        '> [Original post](https://x.com/jack/status/20)',
      ].join('\n')
    );
  });

  it('embeds photos and links videos from their thumbnails', () => {
    const tweet: Tweet = {
      ...base,
      photos: [{ url: 'https://pbs.twimg.com/media/a.jpg', altText: 'A cat' }],
      videos: [
        {
          url: 'https://video.twimg.com/v.mp4',
          thumbnailUrl: 'https://pbs.twimg.com/thumb.jpg',
        },
      ],
    };
    const embed = formatTweetEmbed(tweet, { media: true, labels });
    assert.ok(embed.includes('> ![A cat](https://pbs.twimg.com/media/a.jpg)'));
    assert.ok(
      embed.includes(
        '> [![Video](https://pbs.twimg.com/thumb.jpg)](https://video.twimg.com/v.mp4)'
      )
    );
    const bare = formatTweetEmbed(tweet, { media: false, labels });
    assert.ok(!bare.includes('pbs.twimg.com'));
  });

  it('nests a quoted post a level deeper', () => {
    const tweet: Tweet = {
      ...base,
      text: 'look at this',
      quote: { ...base, id: '21', text: 'the quoted words' },
    };
    const embed = formatTweetEmbed(tweet, { media: true, labels });
    assert.ok(embed.includes('> > **jack (@jack)** · 2006-03-21'));
    assert.ok(embed.includes('> > the quoted words'));
    // Only the outer post gets a link back.
    assert.equal(embed.match(/Original post/g)?.length, 1);
  });

  it('lists a poll under the text', () => {
    const tweet: Tweet = {
      ...base,
      poll: [
        { label: 'Yes', percentage: 75.4 },
        { label: 'No', percentage: 24.6 },
      ],
    };
    const embed = formatTweetEmbed(tweet, { media: true, labels });
    assert.ok(embed.includes('> - Yes — 75%'));
    assert.ok(embed.includes('> - No — 25%'));
  });
});
