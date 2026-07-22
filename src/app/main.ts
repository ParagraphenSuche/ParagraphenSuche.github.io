// Entry point — wired fully in M2 (PDF upload) and M4 (staleness).
const form = document.getElementById('analyze-form') as HTMLFormElement

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const progress = document.getElementById('progress')!
  progress.hidden = false
  progress.textContent = 'Die Analyse-Pipeline ist noch im Aufbau – bald verfügbar.'
})
