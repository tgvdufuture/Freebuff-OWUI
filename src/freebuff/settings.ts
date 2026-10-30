/**
 * `settings.json` du profil Freebuff.
 *
 * La CLI n'accepte pas `--model` : choisir le modèle du prochain lancement
 * passe forcément par ce fichier. Le pont n'écrit QU'UNE clé, `freebuffModel`,
 * après relecture complète — et refuse d'écrire si le fichier n'est pas un
 * objet JSON lisible : écraser un fichier qu'on n'a pas compris effacerait les
 * réglages de l'utilisateur.
 *
 * Le mutex « écriture + lancement » ne vit pas ici mais dans `SessionHost`,
 * qui est le seul à savoir quand un lancement a lieu. `set` reste donc
 * synchrone et simple.
 */
import fs from 'node:fs'
import path from 'node:path'

export class SettingsUnreadable extends Error {
  readonly file: string

  constructor(file: string, cause: string) {
    super(
      `settings.json illisible (${cause}) : le pont refuse de le réécrire. ` +
        `Corrige ou supprime ${file}, puis relance la demande.`,
    )
    this.name = 'SettingsUnreadable'
    this.file = file
  }
}

export class ModelSettings {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /** Le modèle écrit (`freebuffModel`), ou `null` s'il est absent ou illisible. */
  read(): string | null {
    return this.readChoice()?.id ?? null
  }

  /**
   * Les deux clés de modèle telles qu'elles sont écrites.
   *
   * La CLI préfère `freebuffModelKey` : afficher `freebuffModel` seul annonçait
   * « deepseek » alors que la session tournait sur un modèle piloté par clé.
   * Un diagnostic qui nomme le mauvais modèle est pire qu'aucun diagnostic.
   */
  readChoice(): { id: string | null; key: string | null } | null {
    const text = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : null

    try {
      const object = this.readObject()
      const id = text(object.freebuffModel)
      const key = text(object.freebuffModelKey)
      return id === null && key === null ? null : { id, key }
    } catch {
      // Lister les modèles ne doit pas casser sur un profil cassé : le refus
      // explicite arrive au moment d'écrire, pas au moment de lire.
      return null
    }
  }

  /**
   * Écrit la sélection en ne touchant qu'aux clés de modèle.
   *
   * `freebuffModelKey` est PRIORITAIRE dans la CLI : une clé laissée en place
   * garde l'ancien modèle actif, même si `freebuffModel` dit autre chose. On
   * efface donc la clé quand le choix n'en porte pas.
   */
  set(choice: { id: string | null; key: string | null }): void {
    const current = this.readObject()
    if (choice.id !== null) current.freebuffModel = choice.id
    if (choice.key !== null) current.freebuffModelKey = choice.key
    else delete current.freebuffModelKey

    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, this.file)
  }

  private readObject(): Record<string, unknown> {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      // Premier lancement : la CLI créera le fichier, un objet minimal suffit.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new SettingsUnreadable(this.file, error instanceof Error ? error.message : String(error))
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new SettingsUnreadable(this.file, error instanceof Error ? error.message : 'JSON invalide')
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SettingsUnreadable(this.file, 'objet JSON attendu')
    }
    return parsed as Record<string, unknown>
  }
}
