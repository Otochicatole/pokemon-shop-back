import TCGdex, { Query, type CardModel, type CardResumeModel } from '@tcgdex/sdk';
import { logger } from '../../infrastructure/logger.js';
import { AppError, notFound } from '../../shared/errors.js';

const client = new TCGdex('en');
client.setCacheTTL(300);

export type TcgDexCardSummary = {
  id: string;
  name: string;
  localId: string;
  setCode: string;
  imageUrl: string | null;
  setName?: string;
  rarity?: string;
  category?: string;
  types?: string[];
  firstEdition?: boolean;
  holo?: boolean;
};

export type TcgDexCardDetails = TcgDexCardSummary & {
  setName: string;
  description: string;
  rarity: string;
  category: string;
  types: string[];
  firstEdition: boolean;
  holo: boolean;
  effect: string;
  language: string;
};

function imageUrl(card: CardResumeModel) {
  const value = card.getImageURL('high', 'webp');
  return value.startsWith('https://assets.tcgdex.net/') ? value : null;
}

function summary(card: CardResumeModel): TcgDexCardSummary {
  return {
    id: card.id,
    name: card.name,
    localId: card.localId,
    setCode: card.id.split('-')[0] ?? card.id,
    imageUrl: imageUrl(card),
  };
}

function unavailable(error: unknown): AppError {
  logger.warn({ err: error }, 'TCGdex request failed');
  return new AppError(502, 'TCGDEX_UNAVAILABLE', 'No se pudo consultar el catálogo de TCGdex');
}

export async function searchCards(input: string): Promise<TcgDexCardSummary[]> {
  const query = input.trim();
  try {
    const results = await client.card.list(Query.create().contains('name', query).paginate(1, 20));
    const seen = new Set<string>();
    const cards = results.map(summary).filter((card) => {
      if (seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
    const enriched: TcgDexCardSummary[] = [];
    for (let index = 0; index < cards.length; index += 5) {
      const batch = await Promise.all(cards.slice(index, index + 5).map(async (card) => {
        try {
          const detail = await client.card.get(card.id);
          if (!detail) return card;
          const value = detail as CardModel;
          return {
            ...card,
            setName: value.set.name,
            rarity: value.rarity ?? '',
            category: value.category ?? '',
            types: value.types ?? [],
            firstEdition: Boolean(value.variants?.firstEdition),
            holo: Boolean(value.variants?.holo),
          } satisfies TcgDexCardSummary;
        } catch {
          return card;
        }
      }));
      enriched.push(...batch);
    }
    return enriched;
  } catch (error) {
    throw unavailable(error);
  }
}

export async function getCard(id: string): Promise<TcgDexCardDetails> {
  try {
    const card = await client.card.get(id);
    if (!card) throw notFound('Carta no encontrada en TCGdex');
    const value = card as CardModel;
    const base = summary(value);
    return {
      ...base,
      setName: value.set.name,
      description: value.description ?? '',
      rarity: value.rarity ?? '',
      category: value.category ?? '',
      types: value.types ?? [],
      firstEdition: Boolean(value.variants?.firstEdition),
      holo: Boolean(value.variants?.holo),
      effect: value.effect ?? '',
      language: 'Inglés',
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable(error);
  }
}

export async function listRarities(): Promise<string[]> {
  try {
    const rarities = await client.rarity.list();
    return [...new Set(rarities.map((value) => String(value).trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    throw unavailable(error);
  }
}

export type TcgDexSetOption = { id: string; name: string };

export async function listSets(): Promise<TcgDexSetOption[]> {
  try {
    const sets = await client.set.list();
    const options = sets
      .map((set) => ({
        id: String(set.id ?? '').trim(),
        name: String(set.name ?? '').trim(),
      }))
      .filter((set) => set.id && set.name);
    options.sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
    return options;
  } catch (error) {
    throw unavailable(error);
  }
}
