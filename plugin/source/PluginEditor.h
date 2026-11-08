// A minimal native editor (P0): transport / MIDI settings, voice tabs, the voice's
// wavetable and its parameters. The full UI (Generate, Timeline, Wavetables, Sequence)
// is planned as the web UI hosted in a WebView — see docs/PLUGIN.md.
#pragma once

#include "PluginProcessor.h"
#include "WavetableView.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

class MkwavezEditor final : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit MkwavezEditor(MkwavezProcessor&);
    ~MkwavezEditor() override;

    void paint(juce::Graphics&) override;
    void resized() override;

private:
    using SliderAttachment = juce::AudioProcessorValueTreeState::SliderAttachment;
    using ButtonAttachment = juce::AudioProcessorValueTreeState::ButtonAttachment;

    struct Knob {
        juce::Slider slider{juce::Slider::RotaryHorizontalVerticalDrag, juce::Slider::TextBoxBelow};
        juce::Label label;
        std::unique_ptr<SliderAttachment> attachment;
    };

    void timerCallback() override;
    void selectVoice(int slot);

    MkwavezProcessor& proc;
    juce::LookAndFeel_V4 lnf;

    juce::Label title;
    juce::ToggleButton play{"Play"}, hostSync{"Host sync"}, seqFollow{"Seq follows host"}, omni{"Omni"};
    juce::Slider bpm{juce::Slider::LinearBar, juce::Slider::TextBoxLeft};
    juce::Slider midiVoice{juce::Slider::IncDecButtons, juce::Slider::TextBoxLeft};
    juce::Slider gain{juce::Slider::LinearBar, juce::Slider::TextBoxLeft};
    juce::Label bpmLabel, midiLabel, gainLabel, stepLabel;
    std::unique_ptr<ButtonAttachment> playAtt, syncAtt, followAtt, omniAtt;
    std::unique_ptr<SliderAttachment> bpmAtt, midiAtt, gainAtt;

    std::array<juce::TextButton, params::VOICE_SLOTS> tabs;
    int slot = 0;
    WavetableView view;
    std::array<Knob, params::VOICE_FIELD_COUNT> knobs; // the mute entry uses `mute` instead
    juce::ToggleButton mute{"Mute"};
    std::unique_ptr<ButtonAttachment> muteAtt;
    juce::TextButton reset{"Reset project"};
    juce::Label footer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MkwavezEditor)
};
