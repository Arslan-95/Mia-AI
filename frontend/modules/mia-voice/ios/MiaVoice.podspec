Pod::Spec.new do |s|
  s.name           = 'MiaVoice'
  s.version        = '1.0.0'
  s.summary        = 'Mia echo-cancelled capture and playback'
  s.description    = 'One voice-processing audio graph for capture and assistant playback.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
