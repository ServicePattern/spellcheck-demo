import { keepAutoCompletionAfterAutoCorrection } from './auto-completion';
import type { Mistake } from './llm';
import { findMistakesInText, type PlacedMistake } from './mistake-places';
import { directionOfLastWord, findWordPlaces, type WordPlace } from './words';
import type { AssistantContext, TextSpan } from './types';

const AUTO_CORRECTED_FLASH_MS = 2000;

export function stopSpellCheck(context: AssistantContext) {
  closePopover(context);
  context.editorControl.showUnderlines([]);
}

function mistakePlaces(context: AssistantContext, text: string): PlacedMistake[] {
  return findMistakesInText(text, context.spellCheck.mistakes).filter((place) => !context.customDictionary.has(place.word));
}

function finishedMistakePlaces(context: AssistantContext): PlacedMistake[] {
  const text = context.editorControl.getText();
  const caret = context.editorControl.getCaret();
  const isFollowedByBoundary = (place: PlacedMistake) => /^[^\p{L}\p{M}\p{N}]/u.test(text.slice(place.end));
  return mistakePlaces(context, text).filter((place) => place.end !== caret && isFollowedByBoundary(place));
}

export interface SentDraft {
  text: string;
  caret: number | undefined;
}

export function displayAndAutoCorrectMistakes(context: AssistantContext, newMistakes: Mistake[], sentDraft: SentDraft) {
  const keptMistakes = findEarlierMistakesToKeep(context, newMistakes);
  context.spellCheck.mistakes = [...newMistakes, ...keptMistakes];
  context.spellCheck.mistakesOnFinishedWords = [...findMistakesOnFinishedWords(newMistakes, sentDraft), ...keptMistakes];
  const placed = findMistakesInText(context.editorControl.getText(), newMistakes);
  const notFound = newMistakes.filter((mistake) => !placed.some((place) => place.mistake === mistake));
  context.debug('spell-check', `model reported ${newMistakes.length} mistake(s); ${placed.length} place(s) found in the field`, placed.map((place) => `${place.word} @${place.start} → ${place.mistake.fixes.join(' / ')}${place.mistake.isSure ? ' (sure)' : ''}`));
  if (notFound.length) {
    context.debug('spell-check', 'not placed in the text (the word is gone, or the model did not copy the surrounding text exactly and the word is in the text more than once): ignored', notFound);
  }
  if (context.options.spellCheckMode === 'auto-correction') {
    autoCorrectSureMistakes(context);
  } else {
    context.debug('spell-check', 'auto-correction is off: mistakes are only underlined');
  }
  redrawUnderlines(context);
}

function findMistakesOnFinishedWords(newMistakes: Mistake[], sentDraft: SentDraft): Mistake[] {
  const isWordAtCaret = (place: PlacedMistake) => sentDraft.caret !== undefined && place.start <= sentDraft.caret && sentDraft.caret <= place.end;
  const finishedPlaces = findMistakesInText(sentDraft.text, newMistakes).filter((place) => !isWordAtCaret(place));
  return [...new Set(finishedPlaces.map((place) => place.mistake))];
}

function findEarlierMistakesToKeep(context: AssistantContext, newMistakes: Mistake[]): Mistake[] {
  const text = context.editorControl.getText();
  const newPlaces = findMistakesInText(text, newMistakes);
  const isReportedAgain = (place: PlacedMistake) => newPlaces.some((newPlace) => newPlace.start === place.start && newPlace.end === place.end);
  const keptPlaces = findMistakesInText(text, context.spellCheck.mistakesOnFinishedWords).filter((place) => !isReportedAgain(place));
  if (keptPlaces.length) {
    context.debug('spell-check', `${keptPlaces.length} mistake(s) kept from the earlier answers: the model did not report them again, but the word was finished when it was reported and is still unchanged`, keptPlaces.map((place) => `${place.word} @${place.start}`));
  }
  return [...new Set(keptPlaces.map((place) => place.mistake))];
}

export function redrawUnderlines(context: AssistantContext) {
  const text = context.editorControl.getText();
  if (!text.trim()) {
    context.spellCheck.mistakes = [];
  }
  context.editorControl.showUnderlines(mistakePlaces(context, text).map((place) => ({ start: place.start, end: place.end })));
}

interface WordFix {
  place: WordPlace;
  fix: string;
}

function replaceWords(context: AssistantContext, wordFixes: WordFix[]): WordFix[] {
  context.isAutoCorrecting = true;
  try {
    return replaceWordsNow(context, wordFixes);
  } finally {
    context.isAutoCorrecting = false;
  }
}

function replaceWordsNow(context: AssistantContext, wordFixes: WordFix[]): WordFix[] {
  const caretBefore = context.editorControl.getCaret();
  const lastFirst = [...wordFixes].sort((first, second) => second.place.start - first.place.start);
  const applied: WordFix[] = [];
  const autoCorrectedSpans: { start: number; length: number }[] = [];
  let caretShift = 0;

  for (const wordFix of lastFirst) {
    const { place } = wordFix;
    if (context.editorControl.getText().slice(place.start, place.end) !== place.word) {
      context.debug('auto-correction', `skipped "${place.word}" @${place.start}: the text there changed`);
      continue;
    }
    context.debug('auto-correction', `"${place.word}" @${place.start} → "${wordFix.fix}" (native edit: one Ctrl/Cmd+Z)`);

    context.editorControl.replaceText(place.start, place.end, wordFix.fix);
    const lengthChange = wordFix.fix.length - place.word.length;
    if (caretBefore !== undefined && place.end <= caretBefore) {
      caretShift += lengthChange;
    }
    autoCorrectedSpans.forEach((span) => (span.start += lengthChange));
    autoCorrectedSpans.push({ start: place.start, length: wordFix.fix.length });
    applied.push(wordFix);
  }
  if (!applied.length) {
    return applied;
  }

  if (caretBefore !== undefined) {
    context.debug('auto-correction', `caret put back: ${caretBefore} → ${caretBefore + caretShift}`);
    context.editorControl.setCaret(caretBefore + caretShift);
  }
  keepAutoCompletionAfterAutoCorrection(context, caretShift);
  flash(context, autoCorrectedSpans.map((span) => ({ start: span.start, end: span.start + span.length })));
  return applied.reverse();
}

function flash(context: AssistantContext, spans: TextSpan[]) {
  context.editorControl.showAutoCorrectedWords(spans);
  clearTimeout(context.autoCorrectedFlashTimer);
  context.autoCorrectedFlashTimer = setTimeout(() => context.editorControl.showAutoCorrectedWords([]), AUTO_CORRECTED_FLASH_MS);
}

function autoCorrectSureMistakes(context: AssistantContext) {
  const surePlaces = finishedMistakePlaces(context).filter((place) => place.mistake.isSure);
  const ignoredPlaces = surePlaces.filter((place) => context.ignoredWords.includes(place.word));
  if (ignoredPlaces.length) {
    context.debug('spell-check', 'sure mistakes on ignored words: only underlined, never auto-corrected', ignoredPlaces.map((place) => place.word));
  }
  const placesToFix = surePlaces.filter((place) => !ignoredPlaces.includes(place));
  if (placesToFix.length) {
    context.debug('spell-check', `auto-correcting ${placesToFix.length} word(s)`, placesToFix.map((place) => `${place.word} → ${place.mistake.fixes[0]}`));
  }
  const wordFixes = placesToFix.map((place) => ({ place, fix: place.mistake.fixes[0] }));
  for (const { place, fix } of replaceWords(context, wordFixes)) {
    context.spellCheck.fixByOriginal.set(place.word, fix);
  }
}

export function noticeUndo(context: AssistantContext) {
  const text = context.editorControl.getText();
  for (const [original, fix] of context.spellCheck.fixByOriginal) {
    if (!findWordPlaces(text, [original]).length) {
      continue;
    }
    context.debug('spell-check', `Ctrl/Cmd+Z brought back "${original}": it is now ignored and never auto-corrected again`);
    context.spellCheck.fixByOriginal.delete(original);
    context.spellCheck.undoneAutoCorrections.push({ original, fix });
    addIgnoredWord(context, original);
  }
}

export function noticeRedo(context: AssistantContext) {
  const text = context.editorControl.getText();
  const redone = context.spellCheck.undoneAutoCorrections.filter(({ original }) => !findWordPlaces(text, [original]).length);
  for (const { original, fix } of redone) {
    context.debug('spell-check', `Ctrl/Cmd+Shift+Z brought back "${fix}": "${original}" is no longer ignored`);
    context.spellCheck.fixByOriginal.set(original, fix);
    removeIgnoredWord(context, original);
  }
  context.spellCheck.undoneAutoCorrections = context.spellCheck.undoneAutoCorrections.filter((undone) => !redone.includes(undone));
}

export function openPopoverAtCaret(context: AssistantContext): boolean {
  const caret = context.editorControl.getCaret();
  if (caret === undefined) {
    return false;
  }
  const place = mistakePlaces(context, context.editorControl.getText()).find((candidate) => candidate.start <= caret && caret <= candidate.end);
  if (!place) {
    return false;
  }

  context.debug('spell-check', `popover opened for "${place.word}"`, place.mistake.fixes);
  context.spellCheck.openPopover = { place, caretBefore: caret };
  context.setState({
    popover: {
      word: place.word,
      start: place.start,
      end: place.end,
      direction: directionOfLastWord(place.word),
      fixes: place.mistake.fixes,
    },
  });
  return true;
}

export function closePopover(context: AssistantContext, shouldReturnCaret = false) {
  const closing = context.spellCheck.openPopover;
  if (!closing) {
    return;
  }
  context.spellCheck.openPopover = undefined;
  context.setState({ popover: undefined });
  if (shouldReturnCaret && closing.caretBefore !== undefined) {
    context.editorControl.setCaret(closing.caretBefore);
  }
}

export function pickFix(context: AssistantContext, fix: string) {
  const place = context.spellCheck.openPopover?.place;
  closePopover(context, true);
  if (!place || context.editorControl.getText().slice(place.start, place.end) !== place.word) {
    context.debug('spell-check', 'pick ignored: the word changed while the popover was open');
    return;
  }
  context.debug('spell-check', `picked "${fix}" for "${place.word}"`);
  context.editorControl.replaceText(place.start, place.end, fix);
  if (context.ignoredWords.includes(place.word)) {
    context.debug('spell-check', `"${place.word}" is no longer ignored: a fix was picked for it`);
    removeIgnoredWord(context, place.word);
  }
  redrawUnderlines(context);
}

function addIgnoredWord(context: AssistantContext, word: string) {
  context.ignoredWords = [...new Set([...context.ignoredWords, word])];
  context.options.onIgnoredWordsChange(context.ignoredWords);
}

function removeIgnoredWord(context: AssistantContext, word: string) {
  context.ignoredWords = context.ignoredWords.filter((ignoredWord) => ignoredWord !== word);
  context.options.onIgnoredWordsChange(context.ignoredWords);
}

export function addToDictionary(context: AssistantContext, word: string) {
  context.customDictionary.add(word);
  context.options.onCustomDictionaryChange([...context.customDictionary]);
  context.debug('spell-check', `"${word}" added to the custom dictionary`);
  closePopover(context, true);
  redrawUnderlines(context);
}

export function ignoreWord(context: AssistantContext) {
  const place = context.spellCheck.openPopover?.place;
  closePopover(context, true);
  if (!place) {
    return;
  }
  addIgnoredWord(context, place.word);
  context.debug('spell-check', `"${place.word}" added to the ignored words: never auto-corrected`);
}
