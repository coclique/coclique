import sharp from 'sharp'
import * as Path from 'node:path'
import * as Fs from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { chunk } from 'remeda'
import dedent from 'dedent'
import yargs from 'yargs'
import { $ } from 'bun'

const args = await yargs(process.argv.slice(2)).parse()
const stage = !!args['stage']

const listImages = stage
  ? async () => (await $`git ls-files images`.text()).split('\n').filter(entry => !!entry.trim())
  : async () => (await Fs.readdir(Path.resolve('images'))).map(filename => `images/${filename}`)

const filesToRecompress = (await listImages())
  .filter(pathspec => Path.extname(pathspec) !== '.avif')
  .map(pathspec => ({
    from: pathspec,
    to: pathspec.slice(0, -Path.extname(pathspec).length) + '.avif',
  }))

let processed = 0
for (const batch of chunk(filesToRecompress, availableParallelism())) {
  console.log(
    'Processed',
    processed,
    '/ Processing',
    batch.length,
    '/ Pending',
    filesToRecompress.length - processed - batch.length,
  )
  await Promise.all(
    batch.map(async ({ from, to }) => {
      const infile = Path.resolve(from)
      const outfile = Path.resolve(to)
      await sharp(infile).toFile(outfile)
      await Fs.rm(infile)
    }),
  )
  processed += batch.length
}
console.log('Processed', processed, 'file(s)')

if (stage && filesToRecompress.length > 0) {
  await $`git add -u images`
  await $`git add ${filesToRecompress.map(({ to }) => to)}`
}

interface ParsedFilename {
  year: number
  weekInYear: number
  description: string
  pathspec: string
}

const filesAfterRecompress = (await listImages())
  .map(pathspec => {
    const strippedFilename = Path.basename(pathspec, Path.extname(pathspec))
    const match = strippedFilename.match(/^(\d{4})w(\d{2})\s(.+)$/)
    if (!match) {
      console.warn('Ignoring unformatted filename', pathspec)
      return null
    }

    return {
      year: parseInt(match[1]),
      weekInYear: parseInt(match[2]),
      description: match[3].trim(),
      pathspec,
    }
  })
  .filter((x): x is ParsedFilename => x != null)
  .sort((a, b) => b.year - a.year || b.weekInYear - a.weekInYear)

if (filesAfterRecompress.length === 0) {
  console.error('No files to consider!')
  process.exit(1)
}

const useFile = filesAfterRecompress[0]
const metadata = await sharp(Path.resolve(useFile.pathspec)).metadata()

await Fs.writeFile(
  Path.resolve('README.md'),
  dedent`
    <div>
      <img width="${metadata.width}" height="${metadata.height}" alt="urban landscape" src="${useFile.pathspec}">
      <div align="right"><sup><i>${useFile.description}</i></sup></div>
    </div>\n
  `,
)
console.log('Updated README.md')

if (stage) await $`git add -u README.md`
