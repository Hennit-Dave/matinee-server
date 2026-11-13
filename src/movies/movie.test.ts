import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PAGE,
  MAX_QUERY_LENGTH,
  MovieSchema,
  MoviesPageSchema,
  NowPlayingQuerySchema,
  SearchQuerySchema,
  normaliseQuery,
} from './movie.js';

test('the Movie contract has exactly id, title, posterUrl, year, overview', () => {
  assert.deepEqual(Object.keys(MovieSchema.shape).sort(), ['id', 'overview', 'posterUrl', 'title', 'year']);
  assert.doesNotThrow(() =>
    MovieSchema.parse({ id: 1, title: 'T', posterUrl: 'https://image.tmdb.org/t/p/w500/a.jpg', year: 2026, overview: 'x' }),
  );
  assert.doesNotThrow(() => MovieSchema.parse({ id: 1, title: 'T', posterUrl: null, year: null, overview: null }));
});

test('the contract rejects extra fields, a non-URL poster and an over-long overview', () => {
  const base = { id: 1, title: 'T', posterUrl: null, year: null, overview: null };
  assert.throws(() => MovieSchema.parse({ ...base, poster_path: '/x.jpg' }));
  assert.throws(() => MovieSchema.parse({ ...base, posterUrl: '/just/a/path.jpg' }));
  assert.throws(() => MovieSchema.parse({ ...base, overview: 'x'.repeat(201) }));
});

test('MoviesPage is a list plus page info', () => {
  assert.deepEqual(Object.keys(MoviesPageSchema.shape).sort(), ['movies', 'page', 'totalPages', 'totalResults']);
});

test('?page defaults to 1, accepts digits 1..MAX_PAGE, and rejects everything else', () => {
  assert.equal(NowPlayingQuerySchema.parse({}).page, 1);
  assert.equal(NowPlayingQuerySchema.parse({ page: '3' }).page, 3);
  assert.equal(NowPlayingQuerySchema.parse({ page: String(MAX_PAGE) }).page, MAX_PAGE);
  for (const bad of ['0', '-1', '1.5', '1e2', '0x10', ' 3', '', 'abc', String(MAX_PAGE + 1), '99999999999999999999']) {
    assert.throws(() => NowPlayingQuerySchema.parse({ page: bad }), `page=${JSON.stringify(bad)} must be rejected`);
  }
  assert.throws(() => NowPlayingQuerySchema.parse({ page: ['1', '2'] }), 'a repeated ?page= is rejected');
});

test('unknown query keys are rejected (strict objects, same as every route)', () => {
  assert.throws(() => NowPlayingQuerySchema.parse({ page: '1', foo: 'bar' }));
  assert.throws(() => SearchQuerySchema.parse({ q: 'dune', foo: 'bar' }));
});

test('search ?q is normalised: trimmed, whitespace collapsed, lower-cased', () => {
  assert.equal(normaliseQuery('  Dune   PART two '), 'dune part two');
  assert.equal(SearchQuerySchema.parse({ q: '  Dune   PART two ' }).q, 'dune part two');
  assert.equal(SearchQuerySchema.parse({ q: 'DUNE' }).q, SearchQuerySchema.parse({ q: ' dune ' }).q);
  assert.equal(SearchQuerySchema.parse({ q: 'dune' }).page, 1);
});

test('search ?q must be present, non-empty after trimming, and at most MAX_QUERY_LENGTH', () => {
  assert.throws(() => SearchQuerySchema.parse({}));
  assert.throws(() => SearchQuerySchema.parse({ q: '' }));
  assert.throws(() => SearchQuerySchema.parse({ q: '   \t ' }));
  assert.throws(() => SearchQuerySchema.parse({ q: ['a', 'b'] }));
  assert.doesNotThrow(() => SearchQuerySchema.parse({ q: 'a'.repeat(MAX_QUERY_LENGTH) }));
  assert.throws(() => SearchQuerySchema.parse({ q: 'a'.repeat(MAX_QUERY_LENGTH + 1) }));
});
