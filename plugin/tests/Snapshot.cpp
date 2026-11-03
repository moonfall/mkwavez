// Renders the editor in-process to a PNG (docs / visual checks), with a note playing so
// the live play position shows: mkwavez_snapshot out.png [width height]
#include "../source/PluginProcessor.h"

#include <juce_audio_processors/juce_audio_processors.h>

int main(int argc, char** argv) {
    juce::ScopedJuceInitialiser_GUI init;
    const juce::File out = juce::File::getCurrentWorkingDirectory().getChildFile(argc > 1 ? argv[1] : "mkwavez-editor.png");
    std::unique_ptr<juce::AudioProcessor> proc(createPluginFilter());
    proc->setPlayConfigDetails(0, 2, 48000, 512);
    proc->prepareToPlay(48000, 512);
    juce::AudioBuffer<float> buf(2, 512);
    for (int i = 0; i < 20; ++i) {
        juce::MidiBuffer midi;
        if (i == 0) midi.addEvent(juce::MidiMessage::noteOn(1, 57, (juce::uint8) 100), 0);
        proc->processBlock(buf, midi);
    }
    std::unique_ptr<juce::AudioProcessorEditor> ed(proc->createEditorAndMakeActive());
    if (argc > 3) ed->setSize(juce::String(argv[2]).getIntValue(), juce::String(argv[3]).getIntValue());
    const auto img = ed->createComponentSnapshot(ed->getLocalBounds(), true, 1.0f);
    out.deleteFile();
    juce::FileOutputStream stream(out);
    juce::PNGImageFormat png;
    const bool ok = stream.openedOk() && png.writeImageToStream(img, stream);
    std::printf("%s %s\n", ok ? "wrote" : "failed to write", out.getFullPathName().toRawUTF8());
    ed.reset();
    proc->releaseResources();
    return ok ? 0 : 1;
}
