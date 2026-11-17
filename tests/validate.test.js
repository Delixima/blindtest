'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../server/validate');

const track = (title, artists, titleShort) => ({
  title, titleShort: titleShort || title, artist: artists[0], artists,
});

test('normalize : minuscules, accents, ponctuation, espaces', () => {
  assert.equal(v.normalize('  Éléphant   ROSE !! '), 'elephant rose');
  assert.equal(v.normalize("L'Été Indien"), 'lete indien');
  assert.equal(v.normalize('Simon & Garfunkel'), 'simon and garfunkel');
  assert.equal(v.normalize('Cœur'), 'coeur');
});

test('cleanTitle : parenthèses, crochets, suffixes', () => {
  assert.equal(v.cleanTitle('Get Lucky (feat. Pharrell Williams)'), 'get lucky');
  assert.equal(v.cleanTitle('Bohemian Rhapsody - Remastered 2011'), 'bohemian rhapsody');
  assert.equal(v.cleanTitle('Smells Like Teen Spirit [Live]'), 'smells like teen spirit');
  assert.equal(v.cleanTitle('Blinding Lights - Radio Edit'), 'blinding lights');
  assert.equal(v.cleanTitle('Hotel California 2013 Remaster'), 'hotel california');
  assert.equal(v.cleanTitle('Song ft. Someone'), 'song');
  assert.equal(v.cleanTitle('Live Forever'), 'live forever');
});

test('levenshtein et seuils', () => {
  assert.equal(v.levenshtein('kitten', 'sitting'), 3);
  assert.equal(v.levenshtein('', 'abc'), 3);
  assert.equal(v.maxDistance(2), 0);
  assert.equal(v.maxDistance(5), 1);
  assert.equal(v.maxDistance(10), 2);
  assert.equal(v.maxDistance(11), 3);
});

test('titre exact, insensible à la casse et aux accents', () => {
  assert.ok(v.matchTitle('la vie en rose', 'La Vie en Rose'));
  assert.ok(v.matchTitle('ALORS ON DANSE', 'Alors on danse'));
  assert.ok(v.matchTitle('ou va le monde', 'Où va le monde'));
});

test('titre avec feat et remaster ignorés', () => {
  assert.ok(v.matchTitle('get lucky', 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)'));
  assert.ok(v.matchTitle('bohemian rhapsody', 'Bohemian Rhapsody - Remastered 2011'));
  assert.ok(v.matchTitle('Get Lucky feat Pharrell', 'Get Lucky (feat. Pharrell Williams)'));
});

test('titre : la version longue reste acceptée', () => {
  assert.ok(v.matchTitle('dracula with jennie', 'Dracula (with JENNIE)'));
});

test('tolérance aux fautes proportionnelle', () => {
  assert.ok(v.matchTitle('bohemian rapsody', 'Bohemian Rhapsody'));      // 1 faute
  assert.ok(v.matchTitle('smels like ten spirit', 'Smells Like Teen Spirit')); // 2 fautes
  assert.ok(v.matchTitle('helo', 'Hello'));                            // 1 faute, 5 car.
  assert.ok(!v.matchTitle('hell', 'Halo'));                            // 2 fautes, 4 car.
  assert.ok(!v.matchTitle('yesterday', 'Imagine'));
});

test('titres très courts : pas de tolérance', () => {
  assert.ok(v.matchArtist('U2', ['U2']));
  assert.ok(!v.matchArtist('U3', ['U2']));
});

test('espaces manquants tolérés', () => {
  assert.ok(v.matchArtist('daftpunk', ['Daft Punk']));
  assert.ok(v.matchTitle('alorsondanse', 'Alors on danse'));
});

test('artiste : "the" ignoré, fautes tolérées', () => {
  assert.ok(v.matchArtist('beatles', ['The Beatles']));
  assert.ok(v.matchArtist('the beatles', ['The Beatles']));
  assert.ok(v.matchArtist('rolling stone', ['The Rolling Stones']));
  assert.ok(v.matchArtist('stromae', ['Stromae']));
  assert.ok(v.matchArtist('beyonce', ['Beyoncé']));
});

test('artiste : artiste crédité accepté', () => {
  assert.ok(v.matchArtist('jennie', ['Tame Impala', 'JENNIE']));
  assert.ok(v.matchArtist('pharrell williams', ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']));
  assert.ok(!v.matchArtist('rihanna', ['Daft Punk', 'Pharrell Williams']));
});

test('artiste : & et "and" équivalents', () => {
  assert.ok(v.matchArtist('simon and garfunkel', ['Simon & Garfunkel']));
});

test('réponse vide ou absurde refusée', () => {
  assert.deepEqual(v.checkAnswer('', track('Hello', ['Adele']), 'both'), { title: false, artist: false });
  assert.deepEqual(v.checkAnswer('   ', track('Hello', ['Adele']), 'both'), { title: false, artist: false });
  assert.deepEqual(v.checkAnswer('zzzzzz', track('Hello', ['Adele']), 'both'), { title: false, artist: false });
});

test('checkAnswer : mode titre seul ignore l\'artiste', () => {
  const t = track('Hello', ['Adele']);
  assert.deepEqual(v.checkAnswer('adele', t, 'title'), { title: false, artist: false });
  assert.deepEqual(v.checkAnswer('hello', t, 'title'), { title: true, artist: false });
});

test('checkAnswer : mode artiste seul ignore le titre', () => {
  const t = track('Hello', ['Adele']);
  assert.deepEqual(v.checkAnswer('hello', t, 'artist'), { title: false, artist: false });
  assert.deepEqual(v.checkAnswer('adel', t, 'artist'), { title: false, artist: true });
});

test('checkAnswer : mode both, une catégorie à la fois', () => {
  const t = track('Formidable', ['Stromae']);
  assert.deepEqual(v.checkAnswer('formidable', t, 'both'), { title: true, artist: false });
  assert.deepEqual(v.checkAnswer('stromae', t, 'both'), { title: false, artist: true });
});

test('checkAnswer : "artiste - titre" valide les deux', () => {
  const t = track('Formidable', ['Stromae']);
  assert.deepEqual(v.checkAnswer('Stromae - Formidable', t, 'both'), { title: true, artist: true });
  assert.deepEqual(v.checkAnswer('formidable by stromae', t, 'both'), { title: true, artist: true });
  assert.deepEqual(v.checkAnswer('formidable par stromae', t, 'both'), { title: true, artist: true });
});

test('checkAnswer : titre contenant lui-même un séparateur', () => {
  const t = track('Giorgio by Moroder', ['Daft Punk']);
  assert.deepEqual(v.checkAnswer('Daft Punk - Giorgio by Moroder', t, 'both'), { title: true, artist: true });
  assert.deepEqual(v.checkAnswer('giorgio by moroder', t, 'both'), { title: true, artist: false });
});

test('checkAnswer : titre éponyme à l\'artiste', () => {
  const t = track('Bad Romance', ['Lady Gaga']);
  assert.deepEqual(v.checkAnswer('bad romanse', t, 'both'), { title: true, artist: false });
  const t2 = track('Muse', ['Muse']);
  assert.deepEqual(v.checkAnswer('muse', t2, 'both'), { title: true, artist: true });
});

test('checkAnswer : piste absente', () => {
  assert.deepEqual(v.checkAnswer('hello', null, 'both'), { title: false, artist: false });
});
