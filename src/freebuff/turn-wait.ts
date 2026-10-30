/**
 * Quand rendre la main pendant un tour ?
 *
 * Deux plafonds, et ils ne mesurent pas la même chose :
 * - `idleMs` : la CLI n'a RIEN écrit depuis ce délai. Un tour coupé (aucun
 *   `isComplete`, aucun « Main prompt finished ») n'a plus aucun marqueur de
 *   fin : sans ce test, le pont attendrait le plafond total pour rien.
 * - `deadline` : attente maximale, même si l'agent avance encore (PRD §3.3).
 *
 * Chaque étape écrite repousse `lastProgress`, donc un agent qui travaille
 * longtemps n'est jamais coupé par le plafond d'inactivité.
 */
export function waitExpired(input: {
  now: number
  deadline: number
  /** Dernière écriture observée (transcript ou journal CLI). */
  lastProgress: number
  idleMs: number
}): 'idle' | 'total' | null {
  if (input.now - input.lastProgress >= input.idleMs) return 'idle'
  if (input.now >= input.deadline) return 'total'
  return null
}
